#!/bin/bash
set -e
python3 - <<'PY'
from docx import Document
d = Document()
d.add_heading('Q1 hiring plan', 1)
d.add_paragraph('Why: demand grew, and three roles are open. All three start by the end of March.')
for role, job in [('Baker', 'bakes the morning range from 4:00'), ('Delivery driver', 'delivers wholesale orders to cafes'), ('Shift lead', 'runs the shop floor and opens and closes')]:
    d.add_heading(role, 2); d.add_paragraph(job)
d.add_paragraph('Timeline: post in January, interview in February, start by the end of March.')
d.save('/tmp/q1-hiring-plan.docx')
PY
kortix drive put /tmp/q1-hiring-plan.docx "~/From sessions/Q1 hiring plan/q1-hiring-plan.docx"
mkdir -p /logs/agent; echo "✅ Saved to Drive › My files › From sessions › Q1 hiring plan › q1-hiring-plan.docx" > /logs/agent/response.md
