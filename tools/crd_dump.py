import struct,sys
d=open(sys.argv[1],'rb').read()
sig=d[:3]
if sig==b'MGC': n=struct.unpack_from('<H',d,3)[0]; base=5
else: n=struct.unpack_from('<H',d,7)[0]; base=9; print('lastobj',struct.unpack_from('<I',d,3)[0])
print(sig,'n=',n,'size',len(d))
for i in range(n):
    e=d[base+52*i:base+52*i+52]
    off=struct.unpack_from('<I',e,6)[0]
    txt=e[11:51].split(b'\0')[0]
    bl=struct.unpack_from('<H',d,off)[0]; tl=struct.unpack_from('<H',d,off+2)[0]
    print(i, e[:6].hex(), 'off',off,'flag',e[10], repr(txt), len(txt), 'tail',e[51], 'objflag/bmp',bl,'textlen',tl); print('   ',repr(d[off+4:off+4+tl]))
