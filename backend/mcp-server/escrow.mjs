import {
  encodeAbiParameters,
  encodeFunctionData,
  isAddress,
  keccak256,
  parseUnits,
  toBytes,
} from "viem";

export const XLAYER_CHAIN_ID = 196;
export const XLAYER_RPC_URL = "https://rpc.xlayer.tech";
export const XLAYER_USDT_ADDRESS = "0x779ded0c9e1022225f8e0630b35a9b54be713736";

export const AUTHORIZATION_TYPE =
  "PrimePortEscrowAuthorization(bytes32 commitmentHash,address buyer,address provider,address payout,address token,uint256 amount,uint64 deadline,uint256 chainId,address escrow)";
export const AUTHORIZATION_TYPEHASH = keccak256(toBytes(AUTHORIZATION_TYPE));

export const escrowAbi = [
  {
    type: "function",
    name: "fund",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentHash", type: "bytes32" },
      { name: "buyer", type: "address" },
      { name: "provider", type: "address" },
      { name: "payout", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "deadline", type: "uint64" },
      { name: "buyerSignature", type: "bytes" },
      { name: "providerSignature", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "release",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitmentHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "refund",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitmentHash", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "openDispute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "commitmentHash", type: "bytes32" },
      { name: "evidenceHash", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "event",
    name: "EscrowFunded",
    anonymous: false,
    inputs: [
      { indexed: true, name: "commitmentHash", type: "bytes32" },
      { indexed: true, name: "buyer", type: "address" },
      { indexed: true, name: "provider", type: "address" },
      { indexed: false, name: "payout", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
      { indexed: false, name: "deadline", type: "uint64" },
    ],
  },
  {
    type: "event",
    name: "EscrowReleased",
    anonymous: false,
    inputs: [
      { indexed: true, name: "commitmentHash", type: "bytes32" },
      { indexed: true, name: "payout", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "EscrowRefunded",
    anonymous: false,
    inputs: [
      { indexed: true, name: "commitmentHash", type: "bytes32" },
      { indexed: true, name: "buyer", type: "address" },
      { indexed: false, name: "amount", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "DisputeOpened",
    anonymous: false,
    inputs: [
      { indexed: true, name: "commitmentHash", type: "bytes32" },
      { indexed: true, name: "openedBy", type: "address" },
      { indexed: true, name: "evidenceHash", type: "bytes32" },
    ],
  },
  {
    type: "event",
    name: "DisputeResolved",
    anonymous: false,
    inputs: [
      { indexed: true, name: "commitmentHash", type: "bytes32" },
      { indexed: true, name: "resolutionId", type: "bytes32" },
      { indexed: true, name: "verdictHash", type: "bytes32" },
      { indexed: false, name: "providerBps", type: "uint16" },
      { indexed: false, name: "providerAmount", type: "uint256" },
      { indexed: false, name: "buyerAmount", type: "uint256" },
    ],
  },
];

const erc20Abi = [{
  type: "function",
  name: "approve",
  stateMutability: "nonpayable",
  inputs: [
    { name: "spender", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [{ name: "", type: "bool" }],
}];

export function escrowConfig(env = process.env) {
  const address = env.ESCROW_ADDRESS?.trim();
  const token = (env.USDT_ADDRESS ?? XLAYER_USDT_ADDRESS).trim();
  const chainId = Number(env.ESCROW_CHAIN_ID ?? XLAYER_CHAIN_ID);
  const rpcUrl = (env.XLAYER_RPC_URL ?? XLAYER_RPC_URL).trim();
  if (address && !isAddress(address)) throw new Error("ESCROW_ADDRESS is not a valid address");
  if (!isAddress(token)) throw new Error("USDT_ADDRESS is not a valid address");
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("ESCROW_CHAIN_ID is invalid");
  return {
    enabled: Boolean(address),
    address: address?.toLowerCase() ?? null,
    token: token.toLowerCase(),
    chainId,
    rpcUrl,
    decimals: 6,
  };
}

export function requireEscrow(config) {
  if (!config.enabled) {
    throw new Error("Prime Port escrow is not configured; set ESCROW_ADDRESS before accepting hires");
  }
}

export function authorizationHash({
  commitmentHash,
  buyer,
  provider,
  payout,
  amount,
  deadline,
  config,
}) {
  requireEscrow(config);
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint64" },
      { type: "uint256" },
      { type: "address" },
    ],
    [
      AUTHORIZATION_TYPEHASH,
      commitmentHash,
      buyer,
      provider,
      payout,
      config.token,
      amount,
      BigInt(deadline),
      BigInt(config.chainId),
      config.address,
    ],
  ));
}

export const authorizationMessage = (hash) => `Prime Port escrow authorization v1: ${hash}`;

export function buildEscrowAuthorization(pendingHire, config) {
  requireEscrow(config);
  const { commitment, hash: commitmentHash } = pendingHire;
  const amount = parseUnits(commitment.terms.price, config.decimals);
  const fields = {
    commitmentHash,
    buyer: commitment.agent.wallet,
    provider: commitment.freelancer.wallet,
    payout: commitment.freelancer.payoutAddress,
    amount,
    deadline: commitment.terms.deadline,
    config,
  };
  const hash = authorizationHash(fields);
  return {
    version: 1,
    chainId: config.chainId,
    escrowAddress: config.address,
    tokenAddress: config.token,
    commitmentHash,
    buyer: fields.buyer,
    provider: fields.provider,
    payout: fields.payout,
    amount: commitment.terms.price,
    amountUnits: amount.toString(),
    currency: commitment.terms.currency,
    deadline: fields.deadline,
    authorizationHash: hash,
    signThisExactly: authorizationMessage(hash),
  };
}

export function buildFundingRequest(pendingHire, config) {
  const auth = pendingHire.escrow ?? buildEscrowAuthorization(pendingHire, config);
  if (!pendingHire.agentSignature || !pendingHire.freelancerSignature) {
    throw new Error("both escrow authorization signatures are required before funding");
  }
  const fundArgs = [
    auth.commitmentHash,
    auth.buyer,
    auth.provider,
    auth.payout,
    BigInt(auth.amountUnits),
    BigInt(auth.deadline),
    pendingHire.agentSignature,
    pendingHire.freelancerSignature,
  ];
  return {
    version: 1,
    network: `eip155:${auth.chainId}`,
    chainId: auth.chainId,
    escrowAddress: auth.escrowAddress,
    tokenAddress: auth.tokenAddress,
    commitmentHash: auth.commitmentHash,
    authorizationHash: auth.authorizationHash,
    amount: auth.amount,
    amountUnits: auth.amountUnits,
    currency: auth.currency,
    approval: {
      to: auth.tokenAddress,
      value: "0",
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [auth.escrowAddress, BigInt(auth.amountUnits)],
      }),
      description: `Approve exactly ${auth.amount} ${auth.currency} for Prime Port escrow`,
    },
    funding: {
      to: auth.escrowAddress,
      value: "0",
      data: encodeFunctionData({ abi: escrowAbi, functionName: "fund", args: fundArgs }),
      functionName: "fund",
      args: fundArgs.map((value) => typeof value === "bigint" ? value.toString() : value),
      description: `Lock ${auth.amount} ${auth.currency} for ${auth.commitmentHash}`,
    },
  };
}

export function buildReleaseRequest(pendingHire, config) {
  requireEscrow(config);
  return {
    network: `eip155:${config.chainId}`,
    chainId: config.chainId,
    to: config.address,
    value: "0",
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: "release",
      args: [pendingHire.hash],
    }),
  };
}

export function buildRefundRequest(pendingHire, config) {
  requireEscrow(config);
  return {
    network: `eip155:${config.chainId}`,
    chainId: config.chainId,
    to: config.address,
    value: "0",
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: "refund",
      args: [pendingHire.hash],
    }),
  };
}

export function buildDisputeRequest(pendingHire, evidenceHash, config) {
  requireEscrow(config);
  return {
    network: `eip155:${config.chainId}`,
    chainId: config.chainId,
    to: config.address,
    value: "0",
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: "openDispute",
      args: [pendingHire.hash, evidenceHash],
    }),
  };
}
