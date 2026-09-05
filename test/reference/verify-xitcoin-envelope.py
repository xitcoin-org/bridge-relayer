#!/usr/bin/env python3
"""Independent protobuf 6.33.5 structural/re-encoding check, not a chain vector.
Field definitions: pinned Cosmos SDK tx.proto and pos-chain ethsecp256k1 keys.proto.
"""
import json
from pathlib import Path
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
root = Path(__file__).resolve().parents[2]
v = json.loads((root/'test/fixtures/xitcoin-envelope-vector.json').read_text())
f = descriptor_pb2.FileDescriptorProto(name='offline.proto', package='offline', syntax='proto3')
# name, number, protobuf type, repeated?, target message
schema = {
 'Any': [('type_url',1,9,False,None),('value',2,12,False,None)],
 'PubKey': [('key',1,12,False,None)],
 'Body': [('messages',1,11,True,'Any'),('timeout_height',3,4,False,None)],
 'Single': [('mode',1,5,False,None)],
 'Mode': [('single',1,11,False,'Single')],
 'Signer': [('public_key',1,11,False,'Any'),('mode_info',2,11,False,'Mode'),('sequence',3,4,False,None)],
 'Coin': [('denom',1,9,False,None),('amount',2,9,False,None)],
 'Fee': [('amount',1,11,True,'Coin'),('gas_limit',2,4,False,None)],
 'Auth': [('signer_infos',1,11,True,'Signer'),('fee',2,11,False,'Fee')],
 'SignDoc': [('body_bytes',1,12,False,None),('auth_info_bytes',2,12,False,None),('chain_id',3,9,False,None),('account_number',4,4,False,None)],
 'Raw': [('body_bytes',1,12,False,None),('auth_info_bytes',2,12,False,None),('signatures',3,12,True,None)],
}
for name,fields in schema.items():
 m=f.message_type.add(name=name)
 for name,num,typ,repeated,target in fields:
  d=m.field.add(name=name,number=num,type=typ,label=3 if repeated else 1)
  if target: d.type_name='.offline.'+target
pool=descriptor_pool.DescriptorPool();pool.Add(f)
def decode(name,data):
 cls=message_factory.GetMessageClass(pool.FindMessageTypeByName('offline.'+name))
 m=cls.FromString(data);assert m.SerializeToString(deterministic=True)==data
 return m
unhex=lambda s:bytes.fromhex(s[2:])
plan=v['plan'];doc=decode('SignDoc',unhex(plan['signDocHex']));raw=decode('Raw',unhex(v['result']['signedHex']))
assert doc.body_bytes==raw.body_bytes==unhex(plan['bodyHex'])
assert doc.auth_info_bytes==raw.auth_info_bytes==unhex(plan['authInfoHex'])
assert doc.chain_id=='xitcoin-testnet-v2-1' and doc.account_number==0
body=decode('Body',raw.body_bytes);auth=decode('Auth',raw.auth_info_bytes)
assert len(body.messages)==1 and body.messages[0].type_url=='/cosmos.evm.bridge.v1.MsgSubmitAttestation'
assert len(auth.signer_infos)==1
signer=auth.signer_infos[0];assert signer.sequence==0 and signer.mode_info.single.mode==1
assert signer.public_key.type_url=='/cosmos.evm.crypto.v1.ethsecp256k1.PubKey'
assert decode('PubKey',signer.public_key.value).key==unhex(v['input']['account']['publicKeyHex'])
assert len(auth.fee.amount)==1 and auth.fee.amount[0].denom=='axtc' and auth.fee.amount[0].amount=='100'
assert auth.fee.gas_limit==200000 and list(raw.signatures)==[unhex(v['signatureHex'])]
print('Independent protobuf nested field checks and deterministic re-encoding: PASS (synthetic, not chain-generated)')
