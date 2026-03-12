function Header() {
    return (
        <header className="top-bar">
            <div className="top-bar-left">
                <img src="/logo.jpg" alt="TokenCloak" className="top-bar-logo" />
                <span>TOKENCLOAK</span>
            </div>
            <div className="top-bar-right">
                <span className="status-dot" />
                <span>SOLANA MAINNET</span>
            </div>
        </header>
    )
}

export default Header
