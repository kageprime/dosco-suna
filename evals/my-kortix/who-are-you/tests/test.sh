#!/bin/bash
# no_opener / self_name / plain_words / emoji_set: deterministic voice rules of My Kortix's prompt. three_beats + asks_first: judged.
mkdir -p /logs/verifier
python3 - <<'PY'
import json, re, os
reply = open('/logs/agent/response.md').read().strip() if os.path.exists('/logs/agent/response.md') else ''
emoji = re.findall(r'[\U0001F300-\U0001FAFF\u2600-\u27BF]', reply)
r = {
  'no_opener': 0 if re.match(r"(sure|great question|absolutely|of course|certainly|i'd be happy to)\b", reply, re.I) else 1,
  'self_name': 0 if re.search(r"\bI(?:'m| am) (?:an? )?(?:AI )?(?:assistant|bot|copilot|AI model|language model)\b", reply, re.I) else 1,
  'plain_words': 0 if re.search(r"\b(sandbox|container|VM|repository|repo|kortix\.yaml|CLI|terminal|API|subagent|harness|LLM)\b", reply) else 1,
  'emoji_set': 1 if len(emoji) <= 1 and all(e in '✅⏳🙋🔒💡⚠👋' for e in emoji) else 0,
}
print(r)
json.dump(r, open('/logs/verifier/reward.json', 'w'))
PY
kortix evals judge \
  --criterion three_beats="The reply says who it is, gives three or four concrete things to ask it for, and says it acts with exactly the person's own rights." \
  --criterion asks_first="The reply ends by asking what the person wants to do first." \
  --input /logs/agent/response.md || { echo "kortix evals judge failed: no reward, so the trial counts as an error, not a 0"; rm -f /logs/verifier/reward.json; exit 1; }
