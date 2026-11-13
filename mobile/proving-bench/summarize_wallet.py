import json, sys
for path in sys.argv[1:]:
    d = json.loads(open(path).read().strip().splitlines()[-1])
    print(f"{path}: threads={d['threads']} ledger={d['ledger']}")
    for i, r in enumerate(d["rounds"]):
        extra = f"  (first round incl. key load {r['first_round_incl_load_s']:.1f}s)" if r.get("first_round_incl_load_s") else ""
        print(f"  round {i+1}: output {r['output_s']:.2f}s  spend {r['spend_s']:.2f}s  max_rss {r['max_rss_mb']:.0f} MB{extra}")
