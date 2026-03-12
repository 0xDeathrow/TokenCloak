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
            <Header />
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
        </>
    )
}

export default App
