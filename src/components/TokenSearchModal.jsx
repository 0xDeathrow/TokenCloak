import { useState, useEffect, useRef } from 'react'
import { getTokenMetadata, getMultipleTokenMetadata, POPULAR_MINTS } from '../utils/helius'

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
                    background: 'var(--bg-smoke)',
                    width: '100%', height: '100%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: '50%', fontSize: '12px', fontWeight: 700,
                    color: 'var(--text-muted)',
                }}>
                    {token.symbol ? token.symbol[0] : '?'}
                </span>
            )}
        </div>
    )
}

function TokenSearchModal({ onSelect, onClose }) {
    const [search, setSearch] = useState('')
    const [popularTokens, setPopularTokens] = useState([])
    const [customResult, setCustomResult] = useState(null)
    const [loading, setLoading] = useState(true)
    const [searching, setSearching] = useState(false)
    const inputRef = useRef(null)
    const searchTimeout = useRef(null)

    // Fetch popular tokens on mount
    useEffect(() => {
        inputRef.current?.focus()

        async function loadTokens() {
            setLoading(true)
            const popular = await getMultipleTokenMetadata(POPULAR_MINTS)
            setPopularTokens(popular)
            setLoading(false)
        }
        loadTokens()
    }, [])

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

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <span className="modal-title">Select Token</span>
                    <button className="modal-close" onClick={onClose}>✕</button>
                </div>

                <div className="modal-search-wrap">
                    <input
                        ref={inputRef}
                        className="modal-search-input"
                        type="text"
                        placeholder="Search by name, symbol, or paste mint address..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        spellCheck={false}
                    />
                </div>

                <div className="modal-list">
                    {loading && (
                        <div className="modal-loading">Loading tokens...</div>
                    )}

                    {isMintAddress && searching && (
                        <div className="modal-loading">Fetching token info...</div>
                    )}

                    {isMintAddress && customResult && !searching && (
                        <div className="token-row" onClick={() => handleSelect(customResult)}>
                            <TokenIcon token={customResult} />
                            <div className="token-row-info">
                                <div className="token-row-symbol">{customResult.symbol}</div>
                                <div className="token-row-name">{customResult.name}</div>
                            </div>
                        </div>
                    )}

                    {isMintAddress && !customResult && !searching && search.length > 32 && (
                        <div className="modal-empty">Token not found. Check the mint address.</div>
                    )}

                    {!loading && !isMintAddress && filteredPopular.length > 0 && (
                        <>
                            {filteredPopular.map((token) => (
                                <div
                                    key={token.mint}
                                    className="token-row"
                                    onClick={() => handleSelect(token)}
                                >
                                    <div className="token-row-icon">
                                        <TokenIcon token={token} />
                                    </div>
                                    <div className="token-row-info">
                                        <div className="token-row-symbol">{token.symbol}</div>
                                        <div className="token-row-name">{token.name}</div>
                                    </div>
                                </div>
                            ))}
                        </>
                    )}

                    {!loading && !isMintAddress && filteredPopular.length === 0 && (
                        <div className="modal-empty">No tokens found. Paste a mint address to use any SPL token.</div>
                    )}
                </div>
            </div>
        </div>
    )
}

export default TokenSearchModal
