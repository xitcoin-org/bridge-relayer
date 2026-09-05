# Offline optional differential verifier; requires protobuf==6.33.5 in an isolated environment.
import json, re, pathlib
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
root = pathlib.Path(__file__).resolve().parents[2]
schema = (root / 'docs/evidence/xitcoin-tx.proto').read_text()
body = re.search(r'message MsgSubmitAttestation \{(.*?)\n\}', schema, re.S).group(1)
file = descriptor_pb2.FileDescriptorProto(name='pinned-attestation.proto', package='cosmos.evm.bridge.v1', syntax='proto3')
msg = file.message_type.add(name='MsgSubmitAttestation')
types = {'string': 9, 'uint64': 4, 'int64': 3, 'bytes': 12}
for repeated, kind, name, number in re.findall(r'^\s*(repeated\s+)?(string|uint64|int64|bytes)\s+(\w+)\s*=\s*(\d+)', body, re.M):
    msg.field.add(name=name, number=int(number), type=types[kind], label=3 if repeated else 1)
pool = descriptor_pool.DescriptorPool(); pool.Add(file)
Message = message_factory.GetMessageClass(pool.FindMessageTypeByName('cosmos.evm.bridge.v1.MsgSubmitAttestation'))
fixture = json.loads((root / 'test/fixtures/xitcoin-message.json').read_text())
message = Message.FromString(bytes.fromhex(fixture['messageHex'][2:]))
assert message.nonce == 2**64-1
assert message.source_chain_id == '338'
assert message.route_id == 'cronos-testnet-xitcoin-testnet'
assert message.direction == 'cronos_to_xitcoin'
assert message.amount == '10'
assert message.deadline_unix == 2000000000
assert len(message.signatures) == 2 and all(len(s) == 65 for s in message.signatures)
assert message.SerializeToString(deterministic=True).hex() == fixture['messageHex'][2:]
print('PASS: independent Python protobuf 6.33.5 descriptor parsed from pinned proto decodes and deterministically re-encodes exact fixture bytes')
