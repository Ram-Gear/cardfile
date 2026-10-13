import struct,collections
d=open('CARDFILE.EXE','rb').read()
ne=struct.unpack_from('<H',d,0x3c)[0]
segcnt=struct.unpack_from('<H',d,ne+0x1c)[0]; modcnt=struct.unpack_from('<H',d,ne+0x1e)[0]
segtab=ne+struct.unpack_from('<H',d,ne+0x22)[0]
modtab=ne+struct.unpack_from('<H',d,ne+0x28)[0]
imptab=ne+struct.unpack_from('<H',d,ne+0x2a)[0]
align=struct.unpack_from('<H',d,ne+0x32)[0]
mods=[]
for i in range(modcnt):
    o=imptab+struct.unpack_from('<H',d,modtab+2*i)[0]; mods.append(d[o+1:o+1+d[o]].decode())
print(mods)
imps=collections.Counter()
for s in range(segcnt):
    off,ln,fl,mn=struct.unpack_from('<HHHH',d,segtab+8*s)
    if not fl&0x100: continue
    so=off<<align; ln=ln or 0x10000
    r=so+ln; n=struct.unpack_from('<H',d,r)[0]
    for k in range(n):
        at,rt,soff,a,b=struct.unpack_from('<BBHHH',d,r+2+8*k)
        t=rt&3
        if t==1: imps[(mods[a-1],'#%d'%b)]+=1
        elif t==2:
            o=imptab+b; imps[(mods[a-1],d[o+1:o+1+d[o]].decode())]+=1
for k in sorted(imps): print(k)
print('---sites')
segs=[]
for s in range(segcnt):
    off,ln,fl,mn=struct.unpack_from('<HHHH',d,segtab+8*s); segs.append((off<<align,ln or 0x10000,fl))
for s,(so,ln,fl) in enumerate(segs):
    if not fl&0x100: continue
    r=so+ln; n=struct.unpack_from('<H',d,r)[0]
    for k in range(n):
        at,rt,soff,a,b=struct.unpack_from('<BBHHH',d,r+2+8*k)
        if rt&3==1 and mods[a-1]=='USER' and b in (430,471,431,472,473):
            # follow chain
            o=soff; chain=[]
            while True:
                chain.append(o)
                if rt&4: break
                nxt=struct.unpack_from('<H',d,so+o)[0]
                if nxt==0xffff: break
                o=nxt
            print('seg',s+1,'USER#',b,'at',[hex(c) for c in chain])
for s,(so,ln,fl) in enumerate(segs): print(s+1,hex(so),hex(ln),hex(fl)); open('/tmp/seg%d.bin'%(s+1),'wb').write(d[so:so+ln])
