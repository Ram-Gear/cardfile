import struct,pickle
d=open('CARDFILE.EXE','rb').read()
res=pickle.load(open('/tmp/res.pkl','rb'))
for t,rid,off,ln in res:
    b=d[off:off+ln]
    if t=='ACCEL':
        p=0
        while True:
            f,ev,i=struct.unpack_from('<BHH',b,p); p+=5
            print('ACCEL flags=%02x key=%s id=%d'%(f, hex(ev) if f&1 else repr(chr(ev)), i))
            if f&0x80: break
    if t=='STRING':
        p=0
        for k in range(16):
            n=b[p]; s=b[p+1:p+1+n].decode('latin1'); p+=1+n
            if n: print('STR %d: %r'%((rid-1)*16+k,s))
