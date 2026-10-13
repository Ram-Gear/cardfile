import struct,sys
d=open('CARDFILE.EXE','rb').read()
ne=struct.unpack_from('<H',d,0x3c)[0]
assert d[ne:ne+2]==b'NE'
print('linker ver',d[ne+2],d[ne+3])
hdr=struct.unpack_from('<2sBBHHIHHHHHHHHHHHHHHHHHBB',d,ne)
rsrc=ne+struct.unpack_from('<H',d,ne+0x24)[0]
shift=struct.unpack_from('<H',d,rsrc)[0]
p=rsrc+2
types={1:'CURSOR',2:'BITMAP',3:'ICON',4:'MENU',5:'DIALOG',6:'STRING',9:'ACCEL',16:'VERSION',12:'GROUP_CURSOR',14:'GROUP_ICON'}
res=[]
while True:
    t,cnt=struct.unpack_from('<HH',d,p)
    if t==0: break
    p+=8
    for i in range(cnt):
        off,ln,fl,rid=struct.unpack_from('<HHHH',d,p); p+=12
        def name(x):
            if x&0x8000: return x&0x7fff
            o=rsrc+x; return d[o+1:o+1+d[o]].decode()
        res.append((types.get(t&0x7fff,t) if t&0x8000 else name(t),name(rid),off<<shift,ln<<shift))
for r in res: print(r)
import pickle; pickle.dump(res,open('/tmp/res.pkl','wb'))
