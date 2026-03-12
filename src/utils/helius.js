/**
 * Helius DAS API + Jupiter Token API for fetching SPL token metadata.
 * Returns multiple image URL candidates so the UI can cascade on failure.
 */

const HELIUS_API_KEY = import.meta.env.VITE_HELIUS_API_KEY
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`

// In-memory cache
const tokenCache = new Map()

// Multiple IPFS gateways to try in order
const IPFS_GATEWAYS = [
    'https://quicknode.quicknode-ipfs.com/ipfs/',
    'https://cf-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.io/ipfs/',
]

/**
 * Given an IPFS CID, return an array of gateway URLs to try.
 */
function ipfsGatewayUrls(cid) {
    return IPFS_GATEWAYS.map(gw => gw + cid)
}

/**
 * Extract IPFS CID from various URL formats.
 */
function extractIpfsCid(url) {
    if (!url) return null
    // ipfs://CID
    if (url.startsWith('ipfs://')) return url.slice(7)
    // https://ipfs.io/ipfs/CID or similar
    const match = url.match(/\/ipfs\/([a-zA-Z0-9]+)/)
    if (match) return match[1]
    return null
}

/**
 * Build array of candidate image URLs from a single source URL,
 * including multiple IPFS gateway fallbacks.
 */
function buildImageCandidates(url) {
    if (!url) return []
    const cid = extractIpfsCid(url)
    if (cid) {
        return ipfsGatewayUrls(cid)
    }
    if (url.startsWith('ar://')) {
        return ['https://arweave.net/' + url.slice(5)]
    }
    return [url]
}

/**
 * Fetch token image from Jupiter Token API.
 */
async function getJupiterImage(mintAddress) {
    try {
        const res = await fetch(`https://tokens.jup.ag/token/${mintAddress}`)
        if (!res.ok) return null
        const data = await res.json()
        return data.logoURI || null
    } catch {
        return null
    }
}

/**
 * Fetch token metadata from Helius + Jupiter fallback.
 * Returns { symbol, name, images: string[], mint } or null.
 * `images` is an ordered array of URLs to try — the UI cascades through them.
 */
export async function getTokenMetadata(mintAddress) {
    if (tokenCache.has(mintAddress)) {
        return tokenCache.get(mintAddress)
    }

    try {
        const [heliusRes, jupiterImage] = await Promise.all([
            fetch(HELIUS_RPC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 'tokencloak',
                    method: 'getAsset',
                    params: { id: mintAddress },
                }),
            }).then(r => r.json()).catch(() => null),
            getJupiterImage(mintAddress),
        ])

        let symbol = mintAddress.slice(0, 4).toUpperCase()
        let name = 'Unknown Token'
        const imageCandidates = []

        if (heliusRes?.result) {
            const asset = heliusRes.result
            const content = asset.content || {}
            const metadata = content.metadata || {}
            const links = content.links || {}
            const files = content.files || []

            symbol = metadata.symbol || symbol
            name = metadata.name || name

            // 1. Helius cdn_uri (CDN-proxied) — add first
            if (files.length > 0) {
                const imgFile = files.find(f => f.mime && f.mime.startsWith('image/'))
                if (imgFile?.cdn_uri) {
                    imageCandidates.push(imgFile.cdn_uri)
                }
            }

            // 2. Jupiter (reliable CDN)
            if (jupiterImage) {
                imageCandidates.push(jupiterImage)
            }

            // 3. Multiple IPFS gateways from links.image
            if (links.image) {
                imageCandidates.push(...buildImageCandidates(links.image))
            }

            // 4. Multiple IPFS gateways from files[].uri
            if (files.length > 0) {
                const imgFile = files.find(f => f.mime && f.mime.startsWith('image/'))
                if (imgFile?.uri && imgFile.uri !== links.image) {
                    imageCandidates.push(...buildImageCandidates(imgFile.uri))
                }
            }
        } else if (jupiterImage) {
            imageCandidates.push(jupiterImage)
        }

        // Deduplicate
        const uniqueImages = [...new Set(imageCandidates)]

        const tokenInfo = {
            symbol,
            name,
            image: uniqueImages[0] || null,  // primary for backward compat
            images: uniqueImages,             // all candidates for cascade
            mint: mintAddress,
        }

        tokenCache.set(mintAddress, tokenInfo)
        return tokenInfo
    } catch (err) {
        console.warn('Failed to fetch token metadata:', mintAddress, err)
        return null
    }
}

/**
 * Batch-fetch metadata for multiple mint addresses.
 */
export async function getMultipleTokenMetadata(mintAddresses) {
    const results = await Promise.all(
        mintAddresses.map(mint => getTokenMetadata(mint))
    )
    return results.filter(Boolean)
}

// Popular token mints for the default list
export const POPULAR_MINTS = [
    'So11111111111111111111111111111111111111112',     // SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', // WIF
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',   // JUP
    '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',  // RAY
    'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',  // PYTH
    'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',   // ORCA
]

/**
 * Fetch all tokens held by a wallet using Helius DAS getAssetsByOwner.
 * Returns array of { symbol, name, image, images, mint, balance }.
 */
export async function getWalletTokens(walletAddress) {
    if (!walletAddress) return []
    try {
        const res = await fetch(HELIUS_RPC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'wallet-tokens',
                method: 'getAssetsByOwner',
                params: {
                    ownerAddress: walletAddress,
                    displayOptions: { showFungible: true, showNativeBalance: false },
                },
            }),
        })
        const data = await res.json()
        if (!data.result?.items) return []

        return data.result.items
            .filter(a => {
                // Only show fungible tokens (not NFTs)
                const isFungible = a.interface === 'FungibleToken' || a.interface === 'FungibleAsset'
                const hasBalance = a.token_info?.balance > 0
                return isFungible && hasBalance
            })
            .map(asset => {
                const content = asset.content || {}
                const metadata = content.metadata || {}
                const links = content.links || {}
                const files = content.files || []
                const tokenInfo = asset.token_info || {}

                const imageCandidates = []
                if (files.length > 0) {
                    const imgFile = files.find(f => f.mime?.startsWith('image/'))
                    if (imgFile?.cdn_uri) imageCandidates.push(imgFile.cdn_uri)
                }
                if (links.image) imageCandidates.push(...buildImageCandidates(links.image))

                const balance = tokenInfo.balance
                    ? tokenInfo.balance / Math.pow(10, tokenInfo.decimals || 0)
                    : 0

                const token = {
                    symbol: metadata.symbol || asset.id?.slice(0, 4)?.toUpperCase() || '???',
                    name: metadata.name || 'Unknown Token',
                    image: imageCandidates[0] || null,
                    images: [...new Set(imageCandidates)],
                    mint: asset.id,
                    balance,
                    decimals: tokenInfo.decimals || 0,
                }
                tokenCache.set(asset.id, token)
                return token
            })
            .sort((a, b) => b.balance - a.balance)
    } catch (err) {
        console.warn('Failed to fetch wallet tokens:', err)
        return []
    }
}

