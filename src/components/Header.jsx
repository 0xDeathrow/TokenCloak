function Header() {
    return (
        <header className="header">
            <div className="header-left">
                <a href="/" className="header-logo">
                    <img src="/logo.jpg" alt="TokenCloak" />
                    <span className="header-logo-text">
                        Token<span className="accent">Cloak</span>
                    </span>
                </a>
            </div>

            <div className="header-right">
                <div className="header-status">
                    <span className="dot" />
                    <span>Mainnet</span>
                </div>
            </div>
        </header>
    )
}

export default Header
