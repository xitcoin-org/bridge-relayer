import { Transaction, Interface } from "ethers";
import { buildApprovalRequest } from "../../src/approvals.js";
import { DIRECTION_OUTBOUND, cronosRouteId } from "../../src/protocol.js";
import { keys, signers, sign } from "./destination.js";
export function outbound() {
  const vault = "0x1000000000000000000000000000000000000001";
  const request = buildApprovalRequest({ direction: DIRECTION_OUTBOUND, payload: {
    chainId: 338, vault, sourceBurnId: `0x${"ab".repeat(32)}`, recipient: signers[0],
    amount: "10", signerSetVersion: "1", deadline: "2000000000",
  } });
  const identity = { chainId: 338, vault, codeHash: `0x${"cc".repeat(32)}`,
    routeId: cronosRouteId("cronos-testnet-xitcoin-testnet"), submitter: signers[2] };
  return { request, approvals: sign(request), authorizedSigners: signers, nowUnix: 1_900_000_000, identity,
    state: { chainId: 338, vault, codeHash: identity.codeHash, routeId: identity.routeId,
      paused: false, processed: false, signerSetVersion: "1", blockHash: `0x${"dd".repeat(32)}` },
    transaction: { nonce: "0", gasLimit: "200000", gasPrice: "1000000000" },
    limits: { maxGas: "300000", maxGasPrice: "2000000000", maxFee: "600000000000000" } };
}
export function signedBytes(plan, overrides = {}, key = keys[2]) {
  const tx = Transaction.from({ type: 0, chainId: 338, to: plan.to, data: plan.data,
    value: 0, nonce: Number(plan.nonce), gasLimit: plan.gasLimit, gasPrice: plan.gasPrice, ...overrides });
  tx.signature = key.sign(tx.unsignedHash);
  return tx.serialized;
}
export function inclusion(plan, signed) {
  const abi = new Interface(["function release(bytes32,address,uint256,uint64,uint256,bytes[])",
    "event Released(bytes32 indexed sourceBurnId,address indexed recipient,uint256 amount,uint64 signerSetVersion)"]);
  const event = abi.encodeEventLog(abi.getEvent("Released"), abi.decodeFunctionData("release", plan.data).slice(0, 4));
  return { chainId: 338, transactionHash: signed.transactionHash, blockHash: `0x${"ee".repeat(32)}`,
    canonicalBlockHash: `0x${"ee".repeat(32)}`, status: "0x1",
    logs: [{ address: plan.to, topics: event.topics, data: event.data, removed: false }] };
}
