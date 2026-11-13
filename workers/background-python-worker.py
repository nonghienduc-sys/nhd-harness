import ast,json,math,re,sys,time
SAFE_BUILTINS={'abs':abs,'all':all,'any':any,'bool':bool,'dict':dict,'enumerate':enumerate,'float':float,'int':int,'len':len,'list':list,'max':max,'min':min,'range':range,'reversed':reversed,'round':round,'set':set,'sorted':sorted,'str':str,'sum':sum,'tuple':tuple,'zip':zip}
SAFE_MODULES={'math':math,'json':json,'re':re}
ALLOWED_MATH={n for n in dir(math) if not n.startswith('_')}
ALLOWED_JSON={'dumps','loads'}
ALLOWED_RE={'search','match','findall','finditer','sub','split','compile','escape','fullmatch'}
BANNED=(ast.Import,ast.ImportFrom,ast.With,ast.AsyncWith,ast.Lambda,ast.ClassDef,ast.FunctionDef,ast.AsyncFunctionDef,ast.Global,ast.Nonlocal,ast.Delete,ast.Raise,ast.Try,ast.While,ast.For,ast.AsyncFor,ast.Await,ast.Yield,ast.YieldFrom)
def validate(tree):
    for node in ast.walk(tree):
        if isinstance(node,BANNED): raise ValueError(f'Unsupported Python construct: {type(node).__name__}')
        if isinstance(node,ast.Name) and node.id.startswith('_'): raise ValueError('Private names are blocked.')
        if isinstance(node,ast.Attribute):
            if node.attr.startswith('_'): raise ValueError('Private attributes are blocked.')
            if not isinstance(node.value,ast.Name) or node.value.id not in SAFE_MODULES: raise ValueError('Only math/json/re module attributes are allowed.')
            allowed=ALLOWED_MATH if node.value.id=='math' else ALLOWED_JSON if node.value.id=='json' else ALLOWED_RE
            if node.attr not in allowed: raise ValueError(f'Attribute not allowed: {node.value.id}.{node.attr}')
        if isinstance(node,ast.Call):
            if isinstance(node.func,ast.Name):
                if node.func.id not in SAFE_BUILTINS: raise ValueError(f'Function not allowed: {node.func.id}')
            elif isinstance(node.func,ast.Attribute):
                pass
            else: raise ValueError('Indirect calls are blocked.')
def jsonify(v):
    try: json.dumps(v); return v
    except Exception: return repr(v)
def run(code):
    if len(code)>8000: raise ValueError('Python code exceeds 8,000 characters.')
    tree=ast.parse(code,'<background-turbo>','exec'); validate(tree)
    env={'__builtins__':SAFE_BUILTINS,**SAFE_MODULES}; loc={}
    result=None
    if tree.body and isinstance(tree.body[-1],ast.Expr):
        prefix=ast.Module(body=tree.body[:-1],type_ignores=[]); ast.fix_missing_locations(prefix); exec(compile(prefix,'<background-turbo>','exec'),env,loc)
        expr=ast.Expression(tree.body[-1].value); ast.fix_missing_locations(expr); result=eval(compile(expr,'<background-turbo>','eval'),env,loc)
    else: exec(compile(tree,'<background-turbo>','exec'),env,loc)
    return {'result':jsonify(result),'locals':{k:jsonify(v) for k,v in loc.items() if not k.startswith('_')}}
print(json.dumps({'kind':'ready','worker':'python','pid':__import__('os').getpid(),'version':'1.0.0','at':time.time()}),flush=True)
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    t=time.perf_counter(); rid=''
    try:
        req=json.loads(line); rid=str(req.get('id','')); code=str(req.get('code',''))
        if not rid or not code: raise ValueError('Invalid worker request.')
        payload=run(code); out={'kind':'response','id':rid,'ok':True,**payload,'elapsedMs':round((time.perf_counter()-t)*1000,3)}
    except Exception as e: out={'kind':'response','id':rid,'ok':False,'error':str(e),'elapsedMs':round((time.perf_counter()-t)*1000,3)}
    print(json.dumps(out,ensure_ascii=False),flush=True)
