import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import WalletContextProvider from './components/WalletProvider.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <WalletContextProvider>
            <App />
        </WalletContextProvider>
    </React.StrictMode>,
)
