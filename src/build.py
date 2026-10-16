import json
d=json.load(open('data/essen.json',encoding='utf-8'))
data=json.dumps(d,ensure_ascii=False,separators=(',',':')).replace('</','<\\/')
t=open('src/template.html',encoding='utf-8').read()
e=open('src/engine.js',encoding='utf-8').read()
assert '/*DATA*/null' in t and '/*ENGINE*/' in t
out=t.replace('/*DATA*/null',data).replace('/*ENGINE*/',e)
open('index.html','w',encoding='utf-8').write(out)
print(len(out))
