# TAP Paid Attention and Postage Evaluation

## 1. Evaluation Goal

This evaluation focuses on validating whether the current TAP paid-attention and postage mechanisms can reduce unnecessary LLM attention consumption and limit low-value message flooding while preserving important messages.

The evaluation covers three questions:

1. Can notification coalescing reduce the amount of notification context injected into the receiver's LLM prompt?
2. Can prepaid postage create an economic limit on repeated message delivery?
3. Can priority messages remain visible even when ordinary notifications are limited by quota rules?

---

## 2. Environment

Repository:
`trusted-agents`

Branch:
`feat/phase1-notification-coalescing`

Main components evaluated:

- notification coalescing;
- escalation-first rendering;
- attention-related notification reduction;
- prepaid postage credit;
- postage debit and balance exhaustion;
- weekly notification quota;
- priority escalation behavior.

The project was built successfully on Windows after minor local compatibility fixes to TypeScript typing and build scripts.

Some full-repository and E2E tests were affected by Windows-specific native dependency issues, especially the unavailable `@silicon-intern/ows-core-win32-x64-msvc` package.

Because of this, the quantitative evaluation focuses on the core local mechanisms that could be executed reliably in the current environment.

---

## 3. Experiment 1 — Notification Flood and Attention Reduction

### 3.1 Objective

The first experiment evaluates whether notification coalescing can reduce receiver-side notification context under message flooding.

The scenario simulates three peer agents repeatedly sending ordinary messages, followed by one important transfer request requiring approval.

Two notification pipelines are compared:

- Legacy behavior: per-event FIFO rendering with a 20-line cap.
- New TAP behavior: notification coalescing with escalation-first rendering.

Message flood sizes:

- 10 messages
- 50 messages
- 100 messages
- 500 messages
- 1000 messages

Token usage is estimated using the existing project approximation:

`estimated tokens = characters / 4`

Therefore, the reported values are estimated token counts rather than tokenizer-based exact LLM token counts.

### 3.2 Results

| Messages | Legacy Estimated Tokens | New Estimated Tokens | Reduction | Legacy Escalation | New Escalation |
|---:|---:|---:|---:|---|---|
| 10 | 256 | 97 | 62.1% | Visible | Visible |
| 50 | 482 | 98 | 79.7% | Hidden | Visible |
| 100 | 482 | 98 | 79.7% | Hidden | Visible |
| 500 | 482 | 100 | 79.3% | Hidden | Visible |
| 1000 | 483 | 100 | 79.3% | Hidden | Visible |

### 3.3 Interpretation

The results show that notification coalescing substantially reduces the amount of notification context injected into the receiver prompt.

For larger flood sizes, estimated token usage is reduced by approximately 79%.

An important observation is that the new mechanism remains almost constant at around 98–100 estimated tokens even when the number of incoming messages increases from 50 to 1000.

This happens because repeated notifications from the same peer are compressed into counted summary lines instead of being rendered individually.

For example, hundreds of messages from one peer can be represented as a single line such as:

`New message from Alice ... (x334)`

The legacy pipeline also hides the important transfer escalation once the 20-line rendering limit is exceeded.

In contrast, the new TAP pipeline always renders the escalation first.

Therefore, the mechanism improves both:

- attention efficiency;
- visibility of important events.

---

## 4. Experiment 2 — Prepaid Postage and Economic Message Control

### 4.1 Objective

The second experiment evaluates whether prepaid postage creates an explicit economic limit on message delivery.

The experiment directly uses the implemented `FilePostageLedger`.

A sender is given:

`0.002 USDC`

of prepaid postage credit.

The standard message cost is:

`0.001 USDC`

per message.

Three message debit attempts are then performed.

### 4.2 Results

| Message | Cost | Result | Remaining Credit |
|---:|---:|---|---:|
| 1 | 0.001 USDC | Accepted | 0.001 USDC |
| 2 | 0.001 USDC | Accepted | 0 USDC |
| 3 | 0.001 USDC | Rejected | 0 USDC |

The third debit returns:

`insufficient_credit`

### 4.3 Interpretation

The experiment confirms that prepaid postage places a direct economic constraint on repeated message delivery.

A sender with 0.002 USDC credit can purchase exactly two standard attention units at a price of 0.001 USDC each.

After the credit is exhausted, further paid-attention messages are rejected.

This provides an anti-spam mechanism based on economic cost.

Instead of allowing unlimited low-cost messages to consume receiver attention, the sender must maintain sufficient postage credit.

The result also demonstrates the advantage of the prepaid model:

`pay once, spend many`

The sender does not need to perform a separate payment transaction for every individual message.

---

## 5. Experiment 3 — Priority Messages and Notification Quota

### 5.1 Objective

The third evaluation examines the relationship between weekly notification quotas and priority messages.

The implemented TAP logic allows a `message/send` grant to define a constraint such as:

`notificationsPerWeek`

When a grant holder reaches the weekly notification quota, ordinary information notifications are folded into a summary.

However, escalation notifications are intentionally excluded from quota folding.

This includes:

- priority messages;
- pending approvals;
- other escalation events.

### 5.2 Implemented Behavior

The current implementation follows the rule:

- ordinary `info` notifications may be folded after the weekly quota is reached;
- the folded notifications are replaced by a single summary notification;
- escalation notifications are not folded;
- paid priority messages can therefore remain visible even after the ordinary notification quota has been exhausted.

The existing Phase 8 test flow also checks that a grant holder whose normal notification quota is exhausted can still send a priority message that appears as an escalation.

### 5.3 Local Execution Limitation

A direct local execution of the priority/quota benchmark was attempted.

However, the current Windows environment could not load the native OWS dependency:

`@silicon-intern/ows-core-win32-x64-msvc`

The package is not available in the current dependency setup.

Therefore, this experiment is documented based on:

- the implemented quota logic;
- the existing Phase 8 test scenarios;
- source-level validation of escalation-preservation behavior.

The local Windows dependency issue is an environment limitation rather than a logic failure in the quota mechanism.

---

## 6. Overall Findings

The evaluation supports three main findings.

### Finding 1 — Notification coalescing reduces LLM attention cost

Under high message volume, the new notification pipeline reduces estimated notification-token usage by approximately 79%.

The amount of receiver-side notification context remains nearly constant even when the message flood increases from 50 to 1000 messages.

### Finding 2 — Postage creates an explicit economic spam boundary

The prepaid credit experiment shows that messages are accepted only while sufficient postage remains.

Once the sender's credit is exhausted, additional paid-attention messages are rejected.

This introduces a direct economic cost for repeated message delivery.

### Finding 3 — Important messages are preserved

The notification architecture prioritizes escalations over ordinary chatter.

Priority messages and other escalation events are designed to remain visible even when ordinary notifications are coalesced or quota-folded.

---

## 7. Limitations

This evaluation has several limitations.

First, the notification token measurement uses the project's simple `characters / 4` estimation rather than a production LLM tokenizer.

Second, the experiments are local and synthetic rather than based on large-scale real-world agent traffic.

Third, the complete live Phase 6–8 E2E flow was not executed in the current Windows environment because of native dependency limitations related to OWS.

Fourth, the economic experiments validate postage ledger behavior but do not measure real blockchain settlement latency or transaction cost.

Future evaluation could include:

- live XMTP communication between multiple agents;
- deployment on a testnet environment;
- larger and more diverse message workloads;
- real tokenizer measurements;
- latency and throughput benchmarks;
- adaptive attention pricing under changing message load.