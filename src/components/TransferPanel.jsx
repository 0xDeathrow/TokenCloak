import { useState, useCallback } from 'react'
import { useWallet, useConnection } from '@solana/wallet-adapter-react'
import TokenSearchModal from './TokenSearchModal'
import { deposit, withdraw } from '../utils/protocol'

/** Badge icon that cascades through multiple image URLs */
function BadgeIcon({ token }) {
    const images = token.images || (token.image ? [token.image] : [])
    const [idx, setIdx] = useState(0)
    const allFailed = idx >= images.length

    if (!allFailed && images.length > 0) {
        return (
            <div className="token-badge-icon">
                <img src={images[idx]} alt={token.symbol} onError={() => setIdx(prev => prev + 1)} />
            </div>
        )
    }
    return (
        <div className="token-badge-icon" style={{ background: 'var(--red-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 700 }}>
            {token.symbol?.[0] || '?'}
        </div>
    )
}

function TransferPanel({ selectedToken, setSelectedToken, amount, setAmount, recipient, setRecipient, mode, setMode }) {
    const { connected, publicKey, wallet } = useWallet()
    const walletAdapter = useWallet()
    const [showTokenModal, setShowTokenModal] = useState(false)
    const [status, setStatus] = useState(null) // { type: 'loading'|'success'|'error', message, note? }
    const [tab, setTab] = useState('deposit') // 'deposit' | 'withdraw'
    const [withdrawNote, setWithdrawNote] = useState('')
    const [savedNote, setSavedNote] = useState(null)

    const hasAmount = amount && parseFloat(amount) > 0
    const hasRecipient = recipient.length > 30

    // ---- DEPOSIT ----
    const handleDeposit = useCallback(async () => {
        if (!connected || !selectedToken || !hasAmount) return

        setStatus({ type: 'loading', message: 'Preparing deposit...' })
        try {
            setStatus({ type: 'loading', message: 'Generating commitment & building transaction...' })
            const result = await deposit(
                walletAdapter,
                selectedToken.mint || selectedToken.address,
                parseFloat(amount),
                selectedToken.decimals || 9
            )

            setSavedNote(result.note)
            setStatus({
                type: 'success',
                message: `Deposit successful!`,
                note: result.note,
                signature: result.signature,
            })
        } catch (err) {
            console.error('Deposit error:', err)
            setStatus({ type: 'error', message: err.message || 'Deposit failed' })
        }
    }, [connected, selectedToken, amount, walletAdapter])

    // ---- WITHDRAW ----
    const handleWithdraw = useCallback(async () => {
        if (!connected || !selectedToken || !hasAmount || !hasRecipient || !withdrawNote) return

        setStatus({ type: 'loading', message: 'Building withdrawal transaction...' })
        try {
            const result = await withdraw(
                walletAdapter,
                selectedToken.mint || selectedToken.address,
                parseFloat(amount),
                selectedToken.decimals || 9,
                withdrawNote,
                recipient
            )

            setStatus({
                type: 'success',
                message: `Withdrawal complete! Tokens sent to ${recipient.slice(0, 8)}...`,
                signature: result.signature,
            })
        } catch (err) {
            console.error('Withdraw error:', err)
            setStatus({ type: 'error', message: err.message || 'Withdrawal failed' })
        }
    }, [connected, selectedToken, amount, recipient, withdrawNote, walletAdapter])

    const getButtonText = () => {
        if (!connected) return 'Connect Wallet'
        if (!selectedToken) return 'Select a Token'
        if (!amount) return 'Enter Amount'
        if (tab === 'deposit') return status?.type === 'loading' ? 'Processing...' : 'Deposit into Pool'
        // Withdraw tab
        if (!withdrawNote) return 'Paste Secret Note'
        if (!hasRecipient) return 'Enter Recipient Address'
        return status?.type === 'loading' ? 'Processing...' : 'Withdraw from Pool'
    }

    const handleAction = () => {
        if (tab === 'deposit') handleDeposit()
        else handleWithdraw()
    }

    const isDisabled = !connected || !selectedToken || !amount ||
        (tab === 'withdraw' && (!withdrawNote || !hasRecipient)) ||
        status?.type === 'loading'

    return (
        <>
            <div className="cloak-wrapper">
                <div className="cloak-glow" />
                <div className="transfer-panel">
                    <div className="panel-body">

                        {/* Tab Selector */}
                        <div className="tab-selector">
                            <button className={`tab-btn ${tab === 'deposit' ? 'active' : ''}`} onClick={() => { setTab('deposit'); setStatus(null) }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                                Deposit
                            </button>
                            <button className={`tab-btn ${tab === 'withdraw' ? 'active' : ''}`} onClick={() => { setTab('withdraw'); setStatus(null) }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                                Withdraw
                            </button>
                        </div>

                        {/* Token + Amount */}
                        <div className="field-group">
                            <div className="field-label">
                                <span>Token &amp; Amount</span>
                            </div>
                            <div className="token-input-wrap">
                                <button className="token-badge" onClick={() => setShowTokenModal(true)}>
                                    {selectedToken ? (
                                        <>
                                            <BadgeIcon token={selectedToken} />
                                            <span className="token-badge-name">{selectedToken.symbol}</span>
                                        </>
                                    ) : (
                                        <>
                                            <div className="token-badge-icon">?</div>
                                            <span className="token-badge-name" style={{ color: 'var(--text-muted)' }}>Select Token</span>
                                        </>
                                    )}
                                    <span className="token-badge-arrow">▾</span>
                                </button>
                                <input
                                    type="text"
                                    className="amount-input"
                                    placeholder="0.00"
                                    value={amount}
                                    onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                                />
                            </div>
                            {hasAmount && selectedToken && (
                                <div className="field-subtext">
                                    <span>{selectedToken.name}</span>
                                    <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
                                        Fixed pool deposit
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Withdraw-specific: Secret Note + Recipient */}
                        {tab === 'withdraw' && (
                            <>
                                <div className="field-group">
                                    <div className="field-label"><span>Secret Note</span></div>
                                    <input
                                        type="text"
                                        className="address-input"
                                        placeholder="Paste your secret note from deposit..."
                                        value={withdrawNote}
                                        onChange={(e) => setWithdrawNote(e.target.value)}
                                        spellCheck={false}
                                        style={{ fontFamily: 'monospace', fontSize: '12px' }}
                                    />
                                </div>
                                <div className="field-group">
                                    <div className="field-label"><span>Recipient Wallet</span></div>
                                    <input
                                        type="text"
                                        className="address-input"
                                        placeholder="Paste Solana wallet address..."
                                        value={recipient}
                                        onChange={(e) => setRecipient(e.target.value)}
                                        spellCheck={false}
                                    />
                                </div>
                            </>
                        )}

                        {/* CTA */}
                        <button className="btn-transfer" disabled={isDisabled} onClick={handleAction}>
                            {getButtonText()}
                        </button>

                        {/* Status Messages */}
                        {status && (
                            <div className={`status-box ${status.type}`}>
                                {status.type === 'loading' && <div className="status-spinner" />}
                                <div className="status-message">{status.message}</div>
                                {status.signature && (
                                    <a
                                        href={`https://explorer.solana.com/tx/${status.signature}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="status-link"
                                    >
                                        View on Explorer ↗
                                    </a>
                                )}
                            </div>
                        )}

                        {/* Secret Note Display (after deposit) */}
                        {savedNote && tab === 'deposit' && (
                            <div className="note-box">
                                <div className="note-header">
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                                    SAVE YOUR SECRET NOTE
                                </div>
                                <div className="note-warning">
                                    This is the ONLY way to withdraw your tokens. If you lose it, your tokens are gone forever.
                                </div>
                                <div className="note-value" onClick={() => {
                                    navigator.clipboard.writeText(savedNote)
                                    setStatus({ type: 'success', message: 'Note copied to clipboard!' })
                                }}>
                                    {savedNote}
                                </div>
                                <div className="note-hint">Click to copy</div>
                            </div>
                        )}
                    </div>

                    {/* Details Drawer */}
                    {hasAmount && (
                        <div className="details-drawer">
                            <div className="details-row">
                                <span className="details-key">Mode</span>
                                <span className="details-value">{tab === 'deposit' ? 'Deposit → Pool' : 'Pool → Withdraw'}</span>
                            </div>
                            <div className="details-row">
                                <span className="details-key">Network</span>
                                <span className="details-value" style={{ color: '#22c55e' }}>Mainnet</span>
                            </div>
                            <div className="details-row">
                                <span className="details-key">Network Fee</span>
                                <span className="details-value">~0.000005 SOL</span>
                            </div>
                            <div className="details-row">
                                <span className="details-key">Privacy Fee</span>
                                <span className="details-value">{tab === 'deposit' ? '0.07 SOL' : 'Prepaid'}</span>
                            </div>
                            {tab === 'withdraw' && (
                                <div className="details-row">
                                    <span className="details-key">Relay</span>
                                    <span className="details-value green">Via Private Relayer</span>
                                </div>
                            )}
                            <div className="privacy-bar-wrap">
                                <div className="privacy-bar-header">
                                    <span className="privacy-bar-label">Privacy Strength</span>
                                    <span className="privacy-bar-level" style={{ color: '#22c55e' }}>Strong</span>
                                </div>
                                <div className="privacy-bar">
                                    <div className="privacy-bar-fill strong" style={{ width: '78%' }} />
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {showTokenModal && (
                <TokenSearchModal
                    onSelect={(token) => { setSelectedToken(token); setShowTokenModal(false) }}
                    onClose={() => setShowTokenModal(false)}
                />
            )}
        </>
    )
}

export default TransferPanel
