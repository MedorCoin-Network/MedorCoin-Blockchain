/**
 * MEDORCOIN SPECIFIC MAINNET CHAIN REGISTRY ENTRY
 * Configures client web extension parameters to bind with Chain ID 2757 (0xac5).
 */

const MEDORCOIN_MAINNET_PARAMS = {
  chainId: "0xac5", // Hexadecimal conversion for Chain ID 2757
  chainName: "Medorcoin Mainnet",
  nativeCurrency: {
    name: "Medorcoin",
    symbol: "MDC",
    decimals: 18
  },
  rpcUrls: ["https://rpc.medorcoin.org", "http://localhost:5000/api/v1/rpc"],
  blockExplorerUrls: ["https://medorcoin.org"]
};

async function enforceMedorcoinNetworkLink() {
  if (typeof window.ethereum !== 'undefined') {
    try {
      // Prompt wallet extensions to switch directly to your Proof-of-Work network registry
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: MEDORCOIN_MAINNET_PARAMS.chainId }],
      });
      console.log("[Network Registry] Shifted to MedorCoin Mainnet loop successfully.");
    } catch (switchError) {
      // Error code 4902 indicates that the network node registry is missing from the extension setup
      if (switchError.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [MEDORCOIN_MAINNET_PARAMS]
          });
          console.log("[Network Registry] MedorCoin Mainnet configuration parameters injected.");
        } catch (addError) {
          console.error("[Network Registry] Initial configuration injection rejected:", addError.message);
        }
      }
    }
  }
}

if (typeof module !== 'undefined') {
  module.exports = { MEDORCOIN_MAINNET_PARAMS, enforceMedorcoinNetworkLink };
}
