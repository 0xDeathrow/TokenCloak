import { useState, useCallback } from 'react'
import TokenSearchModal from './TokenSearchModal'
import { generateNote } from '../utils/protocol'
import { withdraw } from '../utils/protocol'

const RELAYER_URL = import.meta.env.VITE_RELAYER_URL || 'http://localhost:3001'

/** Badge icon with image fallback */
function BadgeIcon({ token }) {
    const images = token.images || (token.image ? [token.image] : [])
    const [idx, setIdx] = useState(0)
    const allFailed = idx >= images.length

    if (!allFailed && images.length > 0) {
        return <img src={images[idx]} alt={token.symbol} onError={() => setIdx(prev => prev + 1)} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
    }
    return <span>{token.symbol?.[0] || '?'}</span>
}

function TransferPanel({ selectedToken, setSelectedToken, amount, setAmount, recipient, setRecipient }) {
    const [showTokenModal, setShowTokenModal] = useState(false)
    const [status, setStatus] = useState(null)
    const [tab, setTab] = useState('deposit')
    const [withdrawNote, setWithdrawNote] = useState('')
    const [savedNote, setSavedNote] = useState(null)
    const [depositAddress, setDepositAddress] = useState(null)
    const [depositStep, setDepositStep] = useState('idle') // idle | generating | address | verifying | done
    const [withdrawStep, setWithdrawStep] = useState('idle') // idle | proof | relay | submitting | done
    const [copied, setCopied] = useState(false)

    const hasAmount = amount && parseFloat(amount) > 0
    const hasRecipient = recipient.length > 30

    // Deposit steps definition
    const depositSteps = [
        { id: 'select', label: 'SELECT TOKEN & AMOUNT', desc: 'Choose what to deposit' },
        { id: 'generate', label: 'GENERATE ADDRESS', desc: 'Get a unique deposit address' },
        { id: 'send', label: 'SEND TOKENS', desc: 'Transfer from any wallet' },
        { id: 'verify', label: 'VERIFY & DEPOSIT', desc: 'Relayer deposits to pool' },
        { id: 'note', label: 'SAVE SECRET NOTE', desc: 'Your withdrawal key' },
    ]

    const withdrawSteps = [
        { id: 'paste', label: 'PASTE SECRET NOTE', desc: 'From your deposit' },
        { id: 'recipient', label: 'SET RECIPIENT', desc: 'Where tokens go' },
        { id: 'proof', label: 'GENERATE ZK PROOF', desc: 'Privacy computation' },
        { id: 'relay', label: 'PRIVACY RELAY', desc: 'Multi-hop obfuscation' },
        { id: 'complete', label: 'WITHDRAWAL COMPLETE', desc: 'Tokens delivered' },
    ]

    const getActiveStep = () => {
        if (tab === 'deposit') {
            if (depositStep === 'done') return 'note'
            if (depositStep === 'verifying') return 'verify'
            if (depositStep === 'address') return 'send'
            if (depositStep === 'generating') return 'generate'
            if (selectedToken && hasAmount) return 'generate'
            return 'select'
        } else {
            if (withdrawStep === 'done') return 'complete'
            if (withdrawStep === 'submitting') return 'complete'
            if (withdrawStep === 'relay') return 'relay'
            if (withdrawStep === 'proof') return 'proof'
            if (hasRecipient && withdrawNote) return 'recipient'
            if (withdrawNote) return 'paste'
            return 'paste'
        }
    }

    const isStepState = (stepId, steps) => {
        const activeStep = getActiveStep()
        const activeIdx = steps.findIndex(s => s.id === activeStep)
        const stepIdx = steps.findIndex(s => s.id === stepId)
        if (stepIdx < activeIdx) return 'completed'
        if (stepIdx === activeIdx) return 'active'
        return 'pending'
    }

    // ---- DEPOSIT: Generate address ----
    const handleGenerateAddress = useCallback(async () => {
        if (!selectedToken || !hasAmount) return
        setDepositStep('generating')
        setStatus({ type: 'loading', message: 'GENERATING DEPOSIT ADDRESS...' })

        try {
            const tokenMint = selectedToken.mint || selectedToken.address
            const res = await fetch(`${RELAYER_URL}/relay/deposit-address?tokenMint=${tokenMint}`)
            if (!res.ok) throw new Error('Failed to get deposit address')
            const data = await res.json()

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
            setDepositStep('idle')
            setStatus({ type: 'error', message: err.message })
        }
    }, [selectedToken, hasAmount])

    // ---- DEPOSIT: Confirm sent ----
    const handleConfirmSent = useCallback(async () => {
        if (!depositAddress || !selectedToken) return
        setDepositStep('verifying')
        setStatus({ type: 'loading', message: 'VERIFYING TOKENS & DEPOSITING INTO POOL...' })

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
                message: 'DEPOSIT CONFIRMED',
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

        setWithdrawStep('proof')
        setStatus({ type: 'loading', message: 'GENERATING ZK PROOF...' })
        try {
            const onProgress = (update) => {
                if (update.status === 'queued') {
                    setWithdrawStep('relay')
                    const mins = Math.ceil((update.estimatedCompletionMs || 0) / 60000)
                    setStatus({ type: 'loading', message: `PRIVACY RELAY: ~${mins} MIN REMAINING...` })
                } else if (update.status === 'processing') {
                    setWithdrawStep('submitting')
                    setStatus({ type: 'loading', message: 'SUBMITTING WITHDRAWAL...' })
                } else if (update.status === 'completed') {
                    setWithdrawStep('submitting')
                    setStatus({ type: 'loading', message: 'CONFIRMING ON-CHAIN...' })
                }
            }

            const result = await withdraw(
                null,
                selectedToken.mint || selectedToken.address,
                parseFloat(amount),
                selectedToken.decimals || 9,
                withdrawNote,
                recipient,
                onProgress
            )

            setWithdrawStep('done')
            setStatus({
                type: 'success',
                message: `WITHDRAWAL COMPLETE — SENT TO ${recipient.slice(0, 8)}...`,
                signature: result.signature,
            })
        } catch (err) {
            console.error('Withdraw error:', err)
            setWithdrawStep('idle')
            setStatus({ type: 'error', message: err.message || 'WITHDRAWAL FAILED' })
        }
    }, [selectedToken, amount, recipient, withdrawNote])

    const getButtonText = () => {
        if (!selectedToken) return 'SELECT A TOKEN'
        if (!amount) return 'ENTER AMOUNT'
        if (tab === 'deposit') {
            if (depositStep === 'address') return 'I\'VE SENT THE TOKENS →'
            if (depositStep === 'generating' || depositStep === 'verifying') return 'PROCESSING...'
            if (depositStep === 'done') return 'DEPOSIT COMPLETE ✓'
            return 'GENERATE DEPOSIT ADDRESS →'
        }
        if (!withdrawNote) return 'PASTE SECRET NOTE'
        if (!hasRecipient) return 'ENTER RECIPIENT'
        return status?.type === 'loading' ? 'PROCESSING...' : 'EXECUTE WITHDRAWAL →'
    }

    const handleAction = () => {
        if (tab === 'deposit') {
            if (depositStep === 'idle') handleGenerateAddress()
            else if (depositStep === 'address') handleConfirmSent()
        } else {
            handleWithdraw()
        }
    }

    const isDisabled = !selectedToken || !amount ||
        (tab === 'deposit' && (depositStep === 'generating' || depositStep === 'verifying' || depositStep === 'done')) ||
        (tab === 'withdraw' && (!withdrawNote || !hasRecipient)) ||
        status?.type === 'loading'

    const resetDeposit = () => {
        setDepositStep('idle')
        setDepositAddress(null)
        setSavedNote(null)
        setStatus(null)
    }

    const activeSteps = tab === 'deposit' ? depositSteps : withdrawSteps

    return (
        <>
            <main className="main-grid">
                {/* Left: Action Panel */}
                <section className="action-panel">
                    <h1 className="panel-title">{tab === 'deposit' ? 'DEPOSIT' : 'WITHDRAW'}</h1>

                    {/* Tabs */}
                    <div className="tabs">
                        <button className={`tab ${tab === 'deposit' ? 'active' : ''}`} onClick={() => { setTab('deposit'); setStatus(null); resetDeposit(); setWithdrawStep('idle') }}>
                            DEPOSIT
                        </button>
                        <button className={`tab ${tab === 'withdraw' ? 'active' : ''}`} onClick={() => { setTab('withdraw'); setStatus(null); setWithdrawStep('idle') }}>
                            WITHDRAW
                        </button>
                    </div>

                    {/* Token Select */}
                    <div className="form-group">
                        <span className="label">SELECT TOKEN</span>
                        <div className="control-box" tabIndex="0" onClick={() => setShowTokenModal(true)}>
                            {selectedToken ? (
                                <div className="token-select-box">
                                    <div className="token-select-icon">
                                        <BadgeIcon token={selectedToken} />
                                    </div>
                                    <span>{selectedToken.symbol}</span>
                                </div>
                            ) : (
                                <span style={{ color: 'var(--dim)' }}>SELECT TOKEN ▼</span>
                            )}
                            {selectedToken && <span>▼</span>}
                        </div>
                    </div>

                    {/* Amount */}
                    <div className="form-group">
                        <span className="label">AMOUNT</span>
                        <input
                            type="text"
                            className="control-box"
                            placeholder="0.00"
                            value={amount}
                            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                            disabled={depositStep !== 'idle' && tab === 'deposit'}
                        />
                    </div>

                    {/* Deposit: Address display */}
                    {tab === 'deposit' && depositAddress && depositStep !== 'idle' && (
                        <div className="deposit-address-block" onClick={() => {
                            navigator.clipboard.writeText(depositAddress.address)
                            setCopied(true)
                            setTimeout(() => setCopied(false), 2000)
                        }}>
                            <span className="label">DEPOSIT ADDRESS</span>
                            <div className="deposit-address-text">{depositAddress.address}</div>
                            <div className="deposit-address-hint">
                                {copied ? '✓ COPIED' : `CLICK TO COPY · SEND EXACTLY ${amount} ${selectedToken?.symbol}`}
                            </div>
                        </div>
                    )}

                    {/* Withdraw: Note + Recipient */}
                    {tab === 'withdraw' && (
                        <>
                            <div className="form-group">
                                <span className="label">SECRET NOTE</span>
                                <input
                                    type="text"
                                    className="control-box"
                                    style={{ fontSize: '0.85rem', fontFamily: "'SF Mono', monospace" }}
                                    placeholder="PASTE YOUR SECRET NOTE..."
                                    value={withdrawNote}
                                    onChange={(e) => setWithdrawNote(e.target.value)}
                                    spellCheck={false}
                                />
                            </div>
                            <div className="form-group">
                                <span className="label">RECIPIENT WALLET</span>
                                <input
                                    type="text"
                                    className="control-box"
                                    style={{ fontSize: '0.85rem' }}
                                    placeholder="SOLANA WALLET ADDRESS..."
                                    value={recipient}
                                    onChange={(e) => setRecipient(e.target.value)}
                                    spellCheck={false}
                                />
                            </div>
                        </>
                    )}

                    {/* Status */}
                    {status && (
                        <div className={`status-block ${status.type}`}>
                            {status.type === 'loading' && <div className="step-spinner" style={{ margin: '0 auto 1rem' }} />}
                            <div className="status-message">{status.message}</div>
                            {status.signature && (
                                <a href={`https://explorer.solana.com/tx/${status.signature}`} target="_blank" rel="noopener noreferrer" className="status-link">
                                    VIEW ON EXPLORER ↗
                                </a>
                            )}
                        </div>
                    )}

                    {/* Secret Note */}
                    {savedNote && tab === 'deposit' && depositStep === 'done' && (
                        <div className="note-block">
                            <span className="label">⚠ SECRET NOTE — SAVE THIS</span>
                            <div className="note-warning">
                                THIS IS THE ONLY WAY TO WITHDRAW YOUR TOKENS. IF YOU LOSE IT, YOUR TOKENS ARE GONE FOREVER.
                            </div>
                            <div className="note-value" onClick={() => {
                                navigator.clipboard.writeText(savedNote)
                                setStatus({ type: 'success', message: 'NOTE COPIED TO CLIPBOARD' })
                            }}>
                                {savedNote}
                            </div>
                            <div className="note-hint">CLICK TO COPY</div>
                        </div>
                    )}

                    {/* CTA Button */}
                    <button className="submit-btn" disabled={isDisabled} onClick={handleAction}>
                        {getButtonText()}
                    </button>
                </section>

                {/* Right: Steps Panel */}
                <section className="steps-panel">
                    <h2>{tab === 'deposit' ? 'DEPOSIT STEPS' : 'WITHDRAWAL STEPS'}</h2>

                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {activeSteps.map((step, i) => {
                            const state = isStepState(step.id, activeSteps)
                            return (
                                <div key={step.id} className={`step-row ${state}`}>
                                    <div className="step-icon">
                                        {state === 'completed' ? '✓' : (i + 1)}
                                    </div>
                                    <div className="step-details">
                                        <span className="step-label">{step.label}</span>
                                        <span className="step-desc">{step.desc}</span>
                                    </div>
                                    <div className={`step-status ${state === 'completed' ? 'done' : state === 'active' ? 'active-status' : ''}`}>
                                        {state === 'completed' && 'DONE'}
                                        {state === 'active' && (status?.type === 'loading' ? <div className="step-spinner" /> : 'CURRENT')}
                                        {state === 'pending' && '—'}
                                    </div>
                                </div>
                            )
                        })}
                    </div>

                    {/* Info blocks */}
                    <div style={{ marginTop: 'auto', paddingTop: '2rem' }}>
                        <div className="info-block">
                            <span className="label">PROTOCOL</span>
                            <div className="info-value">TOKENCLOAK V3</div>
                        </div>
                        <div className="info-block">
                            <span className="label">PRIVACY</span>
                            <div className="info-value green">ZK-SNARK + MULTI-HOP RELAY</div>
                        </div>
                        <div className="info-block">
                            <span className="label">FEE</span>
                            <div className="info-value">0.07 SOL + 2% TOKEN FEE (MIX + RELAY)</div>
                        </div>
                    </div>
                </section>
            </main>

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
