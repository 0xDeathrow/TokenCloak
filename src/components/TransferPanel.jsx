import { useState, useCallback } from 'react'
import TokenSearchModal from './TokenSearchModal'
import { deposit, withdraw, generateNote } from '../utils/protocol'

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'http://localhost:3001'

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
        <div className="token-badge-icon">
            {token.symbol?.[0] || '?'}
        </div>
    )
}

function TransferPanel({ selectedToken, setSelectedToken, amount, setAmount, recipient, setRecipient, mode, setMode }) {
    const [showTokenModal, setShowTokenModal] = useState(false)
    const [status, setStatus] = useState(null)
    const [tab, setTab] = useState('deposit')
    const [withdrawNote, setWithdrawNote] = useState('')
    const [savedNote, setSavedNote] = useState(null)
    const [depositAddress, setDepositAddress] = useState(null)
    const [depositStep, setDepositStep] = useState('setup') // 'setup' | 'address' | 'waiting' | 'done'

    const hasAmount = amount && parseFloat(amount) > 0
    const hasRecipient = recipient.length > 30

    // ---- DEPOSIT: Generate deposit address ----
    const handleGenerateAddress = useCallback(async () => {
        if (!selectedToken || !hasAmount) return
        setStatus({ type: 'loading', message: 'Generating deposit address & commitment...' })

        try {
            const tokenMint = selectedToken.mint || selectedToken.address
            const res = await fetch(`${RELAYER_URL}/relay/deposit-address?tokenMint=${tokenMint}`)
            if (!res.ok) throw new Error('Failed to get deposit address')
            const data = await res.json()

            // Generate the note client-side
            const note = await generateNote()
            setSavedNote(note.noteString)

            setDepositAddress({
                address: data.depositAddress,
                hopAta: data.hopAta,
                commitment: Array.from(note.commitment),
            })
            setDepositStep('address')
            setStatus(null)
        } catch (err) {
            console.error('Generate address error:', err)
            setStatus({ type: 'error', message: err.message })
        }
    }, [selectedToken, hasAmount])

    // ---- DEPOSIT: Confirm tokens sent ----
    const handleConfirmSent = useCallback(async () => {
        if (!depositAddress || !selectedToken) return
        setDepositStep('waiting')
        setStatus({ type: 'loading', message: 'Verifying tokens & depositing into pool...' })

        try {
            const tokenMint = selectedToken.mint || selectedToken.address
            const mintInfo = await (await fetch(`https://mainnet.helius-rpc.com/?api-key=${import.meta.env.VITE_HELIUS_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [tokenMint, { encoding: 'base64' }] }),
            })).json()

            const decimals = mintInfo.result?.value?.data ? Buffer.from(mintInfo.result.value.data[0], 'base64')[44] : (selectedToken.decimals || 9)
            const rawAmount = BigInt(Math.floor(parseFloat(amount) * Math.pow(10, decimals))).toString()

            const depositRes = await fetch(`${RELAYER_URL}/relay/deposit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tokenMint,
                    depositAmount: rawAmount,
                    commitment: depositAddress.commitment,
                    depositAddress: depositAddress.address,
                }),
            })

            if (!depositRes.ok) {
                const err = await depositRes.json()
                throw new Error(err.error || err.details || 'Deposit failed')
            }

            const result = await depositRes.json()
            setDepositStep('done')
            setStatus({
                type: 'success',
                message: 'Deposit confirmed! Save your secret note below.',
                signature: result.signature,
            })
        } catch (err) {
            console.error('Deposit confirm error:', err)
            setDepositStep('address')
            setStatus({ type: 'error', message: err.message })
        }
    }, [depositAddress, selectedToken, amount])

    // ---- WITHDRAW ----
    const handleWithdraw = useCallback(async () => {
        if (!selectedToken || !hasAmount || !hasRecipient || !withdrawNote) return

        setStatus({ type: 'loading', message: 'Generating ZK proof...' })
        try {
            const onProgress = (update) => {
                if (update.status === 'queued') {
                    const mins = Math.ceil((update.estimatedCompletionMs || 0) / 60000)
                    setStatus({ type: 'loading', message: `Privacy relay: ~${mins} min remaining...` })
                } else if (update.status === 'processing') {
                    setStatus({ type: 'loading', message: 'Submitting withdrawal...' })
                } else if (update.status === 'completed') {
                    setStatus({ type: 'loading', message: 'Confirming on-chain...' })
                }
            }

            const result = await withdraw(
                null, // no wallet needed
                selectedToken.mint || selectedToken.address,
                parseFloat(amount),
                selectedToken.decimals || 9,
                withdrawNote,
                recipient,
                onProgress
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
    }, [selectedToken, amount, recipient, withdrawNote])

    const getButtonText = () => {
        if (!selectedToken) return 'Select a Token'
        if (!amount) return 'Enter Amount'
        if (tab === 'deposit') {
            if (depositStep === 'address') return 'I\'ve Sent the Tokens'
            if (depositStep === 'waiting') return 'Verifying...'
            if (depositStep === 'done') return 'Deposit Complete'
            return status?.type === 'loading' ? 'Generating...' : 'Generate Deposit Address'
        }
        if (!withdrawNote) return 'Paste Secret Note'
        if (!hasRecipient) return 'Enter Recipient Address'
        return status?.type === 'loading' ? 'Processing...' : 'Withdraw'
    }

    const handleAction = () => {
        if (tab === 'deposit') {
            if (depositStep === 'setup') handleGenerateAddress()
            else if (depositStep === 'address') handleConfirmSent()
        } else {
            handleWithdraw()
        }
    }

    const isDisabled = !selectedToken || !amount ||
        (tab === 'deposit' && (depositStep === 'waiting' || depositStep === 'done')) ||
        (tab === 'withdraw' && (!withdrawNote || !hasRecipient)) ||
        status?.type === 'loading'

    const resetDeposit = () => {
        setDepositStep('setup')
        setDepositAddress(null)
        setSavedNote(null)
        setStatus(null)
    }

    return (
        <>
            <div className="cloak-wrapper">
                <div className="transfer-panel">
                    <div className="panel-body">

                        {/* Tab Selector */}
                        <div className="tab-selector">
                            <button className={`tab-btn ${tab === 'deposit' ? 'active' : ''}`} onClick={() => { setTab('deposit'); setStatus(null); resetDeposit() }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12l7 7 7-7" /></svg>
                                Deposit
                            </button>
                            <button className={`tab-btn ${tab === 'withdraw' ? 'active' : ''}`} onClick={() => { setTab('withdraw'); setStatus(null) }}>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                                Withdraw
                            </button>
                        </div>

                        {/* Token + Amount */}
                        <div className="field-group">
                            <div className="field-label">
                                <span>Token & Amount</span>
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
                                            <span className="token-badge-name" style={{ color: 'var(--text-muted)' }}>Select</span>
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
                                    disabled={depositStep !== 'setup' && tab === 'deposit'}
                                />
                            </div>
                        </div>

                        {/* Deposit: Show deposit address */}
                        {tab === 'deposit' && depositAddress && depositStep !== 'setup' && (
                            <div className="deposit-address-box">
                                <div className="deposit-address-label">Send tokens to this address</div>
                                <div className="deposit-address-value" onClick={() => {
                                    navigator.clipboard.writeText(depositAddress.address)
                                    setStatus({ type: 'success', message: 'Address copied!' })
                                    setTimeout(() => { if (depositStep === 'address') setStatus(null) }, 2000)
                                }}>
                                    {depositAddress.address}
                                </div>
                                <div className="deposit-address-copy">Click to copy · Send exactly {amount} {selectedToken?.symbol}</div>
                            </div>
                        )}

                        {/* Withdraw: Secret Note + Recipient */}
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
                                        style={{ fontFamily: "'SF Mono', 'Fira Code', monospace", fontSize: '12px' }}
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
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
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
                                <span className="details-value" style={{ color: 'var(--green)' }}>Mainnet</span>
                            </div>
                            <div className="details-row">
                                <span className="details-key">Privacy Fee</span>
                                <span className="details-value">{tab === 'deposit' ? '0.07 SOL' : '2% skim'}</span>
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
                                    <span className="privacy-bar-level" style={{ color: 'var(--green)' }}>Strong</span>
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
