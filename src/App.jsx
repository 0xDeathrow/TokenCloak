import { useState } from 'react'
import Header from './components/Header'
import TransferPanel from './components/TransferPanel'

function App() {
    const [selectedToken, setSelectedToken] = useState(null)
    const [amount, setAmount] = useState('')
    const [recipient, setRecipient] = useState('')
    const [mode, setMode] = useState('stealth')

    return (
        <>
            {/* Subtle background */}
            <div className="bg-smoke">
                <div className="smoke-layer smoke-1" />
                <div className="smoke-layer smoke-2" />
                <div className="smoke-layer smoke-3" />
            </div>

            <Header />

            <main className="main-layout">
                <div className="hero">
                    <h1 className="hero-title">
                        Private <span className="accent">Token Transfers</span>
                    </h1>
                    <p className="hero-desc">
                        Transfer any SPL token privately. No wallet connection required. Zero on-chain link between sender and recipient.
                    </p>
                </div>

                <TransferPanel
                    selectedToken={selectedToken}
                    setSelectedToken={setSelectedToken}
                    amount={amount}
                    setAmount={setAmount}
                    recipient={recipient}
                    setRecipient={setRecipient}
                    mode={mode}
                    setMode={setMode}
                />
            </main>

            <footer className="footer">
                Zero-knowledge proofs on Solana &middot; <a href="#">Docs</a> &middot; <a href="#">GitHub</a>
            </footer>
        </>
    )
}

export default App
