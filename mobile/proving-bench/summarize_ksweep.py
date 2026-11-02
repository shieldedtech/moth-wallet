import json,sys,statistics as st
L=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ks=sorted({x["k"] for x in L if "k" in x})
print("k  | pk_init | prove median (s) | verified | peak MB")
for k in ks:
    ld=[x for x in L if x.get("k")==k and x["event"]=="loaded"]
    pr=[x for x in L if x.get("k")==k and x["event"]=="proof"]
    to=[x for x in L if x.get("k")==k and x["event"]=="timeout"]
    er=[x for x in L if x.get("k")==k and x["event"]=="error"]
    pk=ld[0]["pk_init_s"] if ld else None
    med=st.median(x["prove_s"] for x in pr) if pr else None
    peak=max([x.get("phys_footprint_peak_mb",0) for x in pr+to+ld] or [0])
    print(f"{k:2} | {pk if pk is None else round(pk,2)} | {None if med is None else round(med,2)} {[round(x['prove_s'],2) for x in pr]} | {all(x['verified'] for x in pr) if pr else '-'} | {peak:.0f}" + (" TIMEOUT" if to else "") + (f" ERROR {er[0]['error'][:80]}" if er else ""))
