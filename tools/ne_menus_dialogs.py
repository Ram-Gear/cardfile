import struct,pickle
d=open('CARDFILE.EXE','rb').read()
res=pickle.load(open('/tmp/res.pkl','rb'))
def cstr(b,p):
    e=b.index(b'\0',p); return b[p:e].decode('latin1'),e+1
def nameord(b,p):
    if b[p]==0xff: return '#%d'%struct.unpack_from('<H',b,p+1)[0],p+3
    return cstr(b,p)
cls={0x80:'BUTTON',0x81:'EDIT',0x82:'STATIC',0x83:'LISTBOX',0x84:'SCROLLBAR',0x85:'COMBOBOX'}
for t,rid,off,ln in res:
    b=d[off:off+ln]
    if t=='MENU':
        p=4; depth=0
        stack=[]
        def parse(p,depth):
            while True:
                fl=struct.unpack_from('<H',b,p)[0]; p+=2
                if fl&0x10:
                    s,p=cstr(b,p); print('  '*depth+'POPUP '+repr(s)); p=parse(p,depth+1)
                else:
                    i=struct.unpack_from('<H',b,p)[0]; p+=2
                    s,p=cstr(b,p); print('  '*depth+'%d %r flags=%x'%(i,s,fl))
                if fl&0x80: return p
        parse(p,0)
    if t=='DIALOG':
        style,n,x,y,cx,cy=struct.unpack_from('<IBHHHH',b,0); p=13
        menu,p=nameord(b,p); c,p=cstr(b,p); cap,p=cstr(b,p)
        if style&0x40: p+=2; f,p=cstr(b,p)
        print('DIALOG %s %r %dx%d'%(rid,cap,cx,cy))
        for k in range(n):
            x,y,cx,cy,i,st=struct.unpack_from('<HHHHHI',b,p); p+=14
            if b[p]&0x80: cl=cls.get(b[p],b[p]); p+=1
            else: cl,p=cstr(b,p)
            tx,p=nameord(b,p); ex=b[p]; p+=1+ex
            print('   id=%d %s %r at(%d,%d,%d,%d) style=%08x'%(i,cl,tx,x,y,cx,cy,st))
