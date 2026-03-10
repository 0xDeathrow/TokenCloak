import { useWallet } from '@solana/wallet-adapter-react'
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui'

function Header() {
    const { connected, publicKey } = useWallet()

    return (
        <header className="header">
            <div className="header-left">
                <a href="/" className="header-logo">
                    <img src="/LOGO.jpg" alt="TokenCloak" />
                    <span className="header-logo-text">
                        Token<span className="accent">Cloak</span>
                    </span>
                </a>
            </div>

            <div className="header-right">
                <WalletMultiButton />
            </div>
        </header>
    )
}

export default Header
