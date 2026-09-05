#!/usr/bin/env python3
"""Register only numeric area-summary assets already enumerated by the builder."""
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def main():
    allow=json.loads((ROOT/'release-allowlist.json').read_text())
    index=json.loads((ROOT/'data/area-index.json').read_text())
    extra=['area.js','analysis-worker.js','data/area-index.json','scripts/build_area_data.py',
           'scripts/build_global_area_data.py','scripts/check_area_accuracy.py',
           'scripts/register_area_release.py','tests/area.test.mjs','tests/display-contract.test.mjs']
    binaries=[item for item in allow['allowed_binary_assets'] if not item['path'].startswith('data/')]
    for kind,field in [('area','tiles'),('global','global_tiles')]:
        for key,record in sorted(index[field].items()):
            path=f'data/{kind}-v1/{key}.json.gz'
            extra.append(path);binaries.append({'path':path,'mime_type':'application/gzip',**record})
    allow['allowed_files']=sorted(set([p for p in allow['allowed_files'] if not p.startswith('data/')]+extra))
    allow['allowed_binary_assets']=binaries
    allow['large_text_files']={'release-allowlist.json':2500000,'release-manifest.json':2000000,'data/area-index.json':1500000}
    (ROOT/'release-allowlist.json').write_text(json.dumps(allow,ensure_ascii=False,indent=2)+'\n')
    print(f'AREA_RELEASE_REGISTERED assets={len(binaries)-2}')

if __name__=='__main__':main()
