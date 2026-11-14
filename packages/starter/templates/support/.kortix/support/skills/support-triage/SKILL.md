---
name: support-triage
description: Triage one support conversation for the Support Factory - the category (how-to, bug, feature-request, billing, account, security, other), the priority 1-4, a confidence, and whether it is noise or an escalation. Writes the `[support-loop] triaged` note and the category tag. Load it for contract step 2 of the support-loop skill, or when a person asks to triage a conversation.
---

# Support triage

Input: one conversation from `conversation.get`. Output: one
`[support-loop] triaged` note and one category tag. The `support-loop`
contract rules apply.

## 1. Read

Read the whole conversation, then decide on the newest customer message.
Keep the surface (the page, the feature, the API route, the integration), the
action the customer took, the result they expected and the result they got.

## 2. Noise first

Noise gets `[support-loop] skipped · noise` and nothing else: vendor pitches,
SEO and link offers, "congrats on launching", recruiter mail, auto-replies,
bounces, newsletters. A security disclosure is never noise, even when it
looks like a pitch for a bug bounty.

## 3. Category

| Category | The customer |
|---|---|
| `security` | reports a vulnerability, a suspected breach, leaked data, an account they did not create, or threatens legal action |
| `billing` | asks about a charge, an invoice, a refund, a plan change or a cancellation |
| `account` | cannot sign in, wants an email, an owner or a member changed, or wants data exported or deleted |
| `bug` | did an action and got a wrong result: names a surface, an action and a result |
| `how-to` | asks how to do something the product already does |
| `feature-request` | asks for something the product does not do |
| `other` | none of the above |

First match from the top wins. A conversation with two asks takes the
higher row and names the second in the note.

## 4. Priority

| Priority | When |
|---|---|
| 1 | `security`; several customers blocked; data loss; the product is down for the customer |
| 2 | a `bug` that blocks the customer's work; `billing` with a charge the customer disputes |
| 3 | a `bug` with a workaround; `account`; a `how-to` the customer waits on |
| 4 | `feature-request`; `other` |

## 5. Confidence

A number from 0.00 to 1.00 for "the category is right and the docs or the
code answer the question". Start at 0.50. Add 0.20 when a docs page answers
it exactly, 0.20 when the code confirms the behavior, 0.10 when the customer
gave every detail. Subtract 0.30 when the message is ambiguous, 0.20 when the
customer is upset, 0.20 when the answer depends on their account data. Clamp
to 0.00-1.00. The confidence decides `auto_reply` (contract §6); write it
honestly.

## 6. Escalation

Escalate (contract §5 step 3) when the category is `security`, when the
customer asks for money or an account change, when the customer is angry or
threatens to leave, or when the conversation is about another customer's
data. Escalation does not stop the draft for `billing` and `account`: the
draft says what a person will do next, never that it is done.

## 7. Write

```
[support-loop] triaged · <category> · <priority> · confidence <0.00>
<surface> · <one line: what the customer needs, paraphrased>
support-key: <key>
```

Then `tag.add(<category>)`.
