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
            {/* Animated smoke background */}
            <div className="bg-smoke">
                <div className="smoke-layer smoke-1" />
                <div className="smoke-layer smoke-2" />
                <div className="smoke-layer smoke-3" />
                <div className="smoke-layer smoke-4" />
            </div>
            <div className="bg-noise" />

            <Header />

            <main className="main-layout">
                <div className="hero">
                    <h1 className="hero-title">
                        Private <span className="accent">Token Transfers</span>
                    </h1>
                    <p className="hero-desc">
                        Transfer any SPL token to any wallet. Zero on-chain link between sender and recipient. No Bubblemaps connections.
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
                Powered by zero-knowledge proofs on Solana &middot; <a href="#">Docs</a> &middot; <a href="#">GitHub</a>
            </footer>
        </>
    )
}

export default App
