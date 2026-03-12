import { useState, useEffect, useRef } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { getTokenMetadata, getMultipleTokenMetadata, getWalletTokens, POPULAR_MINTS } from '../utils/helius'

/** Token icon that cascades through multiple image URLs on failure */
function TokenIcon({ token }) {
    const images = token.images || (token.image ? [token.image] : [])
    const [idx, setIdx] = useState(0)
    const allFailed = idx >= images.length

    return (
        <div className="token-list-icon">
            {!allFailed && images.length > 0 ? (
                <img
                    src={images[idx]}
                    alt={token.symbol}
                    onError={() => setIdx(prev => prev + 1)}
                    style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
                />
            ) : (
                <span style={{
                    background: 'var(--red-muted)',
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: '50%', fontSize: '12px', fontWeight: 700
                }}>
                    {token.symbol ? token.symbol[0] : '?'}
                </span>
            )}
        </div>
    )
}

function TokenSearchModal({ onSelect, onClose }) {
    const { publicKey } = useWallet()
    const [search, setSearch] = useState('')
    const [walletTokens, setWalletTokens] = useState([])
    const [popularTokens, setPopularTokens] = useState([])
    const [customResult, setCustomResult] = useState(null)
    const [loading, setLoading] = useState(true)
    const [searching, setSearching] = useState(false)
    const inputRef = useRef(null)
    const searchTimeout = useRef(null)

    // Fetch wallet tokens + popular tokens on mount
    useEffect(() => {
        inputRef.current?.focus()

        async function loadTokens() {
            setLoading(true)

            // Fetch wallet tokens and popular tokens in parallel
            const [wallet, popular] = await Promise.all([
                publicKey ? getWalletTokens(publicKey.toBase58()) : Promise.resolve([]),
                getMultipleTokenMetadata(POPULAR_MINTS),
            ])

            setWalletTokens(wallet)

            // Filter out popular tokens already in wallet list
            const walletMints = new Set(wallet.map(t => t.mint))
            setPopularTokens(popular.filter(t => !walletMints.has(t.mint)))

            setLoading(false)
        }
        loadTokens()
    }, [publicKey])

    // Detect mint address and fetch metadata
    const isMintAddress = search.length >= 32 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(search)

    useEffect(() => {
        if (searchTimeout.current) clearTimeout(searchTimeout.current)

        if (isMintAddress) {
            setSearching(true)
            searchTimeout.current = setTimeout(async () => {
                const result = await getTokenMetadata(search)
                setCustomResult(result)
                setSearching(false)
            }, 300)
        } else {
            setCustomResult(null)
            setSearching(false)
        }

        return () => {
            if (searchTimeout.current) clearTimeout(searchTimeout.current)
        }
    }, [search, isMintAddress])

    // Filter tokens by search text
    const filterFn = (t) =>
        t.symbol.toLowerCase().includes(search.toLowerCase()) ||
        t.name.toLowerCase().includes(search.toLowerCase())

    const filteredWallet = search && !isMintAddress
        ? walletTokens.filter(filterFn)
        : walletTokens

    const filteredPopular = search && !isMintAddress
        ? popularTokens.filter(filterFn)
        : popularTokens

    const handleSelect = (token) => {
        onSelect({
            symbol: token.symbol,
            name: token.name,
            mint: token.mint,
            image: token.image,
            images: token.images || (token.image ? [token.image] : []),
        })
    }

    const formatBalance = (bal) => {
        if (bal >= 1_000_000) return (bal / 1_000_000).toFixed(2) + 'M'
        if (bal >= 1_000) return (bal / 1_000).toFixed(2) + 'K'
        if (bal >= 1) return bal.toFixed(2)
        return bal.toFixed(6)
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Select Token</span>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-search">
                    <input
                        ref={inputRef}
                        type="text"
                        placeholder="Search by name, symbol, or paste mint address..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        spellCheck={false}
                    />
                    <div className="modal-hint">
                        Any SPL token is supported — paste the mint address to transfer any token.
                    </div>
                </div>

                <div className="modal-list">
                    {/* Loading state */}
                    {loading && (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                            Loading tokens...
                        </div>
                    )}

                    {/* Custom mint result */}
                    {isMintAddress && searching && (
                        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                            Fetching token info...
                        </div>
                    )}

                    {isMintAddress && customResult && !searching && (
                        <div className="token-list-item" onClick={() => handleSelect(customResult)}>
                            <TokenIcon token={customResult} />
                            <div className="token-list-info">
                                <div className="token-list-name">{customResult.symbol} — {customResult.name}</div>
                                <div className="token-list-mint">{customResult.mint}</div>
                            </div>
                        </div>
                    )}

                    {isMintAddress && !customResult && !searching && search.length > 32 && (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                            Token not found. Check the mint address.
                        </div>
                    )}

                    {/* Wallet tokens section */}
                    {!loading && !isMintAddress && filteredWallet.length > 0 && (
                        <>
                            <div style={{
                                padding: '8px 16px 4px',
                                fontSize: '11px',
                                fontWeight: 600,
                                color: 'var(--accent)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.5px',
                            }}>
                                Your Wallet
                            </div>
                            {filteredWallet.map((token) => (
                                <div
                                    key={`w-${token.mint}`}
                                    className="token-list-item"
                                    onClick={() => handleSelect(token)}
                                >
                                    <TokenIcon token={token} />
                                    <div className="token-list-info">
                                        <div className="token-list-name">{token.symbol} — {token.name}</div>
                                        <div className="token-list-mint">{token.mint}</div>
                                    </div>
                                    <div style={{
                                        marginLeft: 'auto',
                                        fontSize: '12px',
                                        color: 'var(--text-muted)',
                                        fontFamily: 'monospace',
                                        flexShrink: 0,
                                        paddingLeft: '8px',
                                    }}>
                                        {formatBalance(token.balance)}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}

                    {/* Popular tokens section */}
                    {!loading && !isMintAddress && filteredPopular.length > 0 && (
                        <>
                            {filteredWallet.length > 0 && (
                                <div style={{
                                    padding: '8px 16px 4px',
                                    fontSize: '11px',
                                    fontWeight: 600,
                                    color: 'var(--text-muted)',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                }}>
                                    Popular Tokens
                                </div>
                            )}
                            {filteredPopular.map((token) => (
                                <div
                                    key={token.mint}
                                    className="token-list-item"
                                    onClick={() => handleSelect(token)}
                                >
                                    <TokenIcon token={token} />
                                    <div className="token-list-info">
                                        <div className="token-list-name">{token.symbol} — {token.name}</div>
                                        <div className="token-list-mint">{token.mint}</div>
                                    </div>
                                </div>
                            ))}
                        </>
                    )}

                    {!loading && !isMintAddress && filteredWallet.length === 0 && filteredPopular.length === 0 && (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                            No tokens found. Paste a mint address to transfer any SPL token.
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default TokenSearchModal
