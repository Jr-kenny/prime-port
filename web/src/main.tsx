import "./polyfills";
import React from "react";
import { createRoot } from "react-dom/client";
import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import "./styles.css";

// Privy app ids are public identifiers (like a Firebase config), safe in source.
const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? "cmrgv18r1001s0cjq7qddgr8o";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ["email", "google"],
        // showWalletUIs off: the design promise is "no crypto experience
        // needed", so XMTP registration and countersigning must not surface
        // wallet confirmation modals.
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" }, showWalletUIs: false },
        appearance: { theme: "light" },
      }}
    >
      <App />
    </PrivyProvider>
  </React.StrictMode>,
);
