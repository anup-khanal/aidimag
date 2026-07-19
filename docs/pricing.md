# Pricing

Simple licensing: **self-host for free** on small teams, or **go commercial** when you need managed cloud sync or exceed the OSS user limit.

<p class="pricing-lead">Full product on your machines for small teams — cloud adds managed sync and zero server ops.</p>

<div class="pricing-grid">

<div class="pricing-card">

### Self-hosted · Free

<p class="pricing-price"><strong>$0</strong> <span>forever</span></p>
<p class="pricing-sub">Elastic License 2.0 · teams of 10 or fewer users</p>

<p class="pricing-features-label">Included</p>
<ul class="pricing-features">
<li>Full CLI, MCP server, and IDE extensions</li>
<li>Local <code>memory.db</code> — agents stay fast</li>
<li>Verified memory, guardrails, skills, tickets</li>
<li>Self-hosted team sync (<code>dim serve</code>)</li>
<li>Local web dashboard (<code>dim ui</code>)</li>
<li>No credit card · no time limit</li>
</ul>

<p class="pricing-features-label">Not included</p>
<ul class="pricing-features pricing-features-no">
<li>Managed hosted sync (24/7)</li>
<li>Cloud accounts, API keys, and billing portal</li>
<li>Device login via cloud approve flow</li>
<li>Zero server ops — you run and maintain sync</li>
<li>Teams over 10 users without a commercial license</li>
</ul>

<p class="pricing-cta"><a class="pricing-button" href="/aidimag/getting-started">Get started</a></p>

</div>

<div class="pricing-card pricing-card-highlight">

<p class="pricing-badge">Managed sync</p>

### aiDimag Cloud · Commercial

<p class="pricing-price"><strong>Hosted</strong> <span>sync &amp; accounts</span></p>
<p class="pricing-sub">For teams who want always-on sync without running a server</p>

<ul class="pricing-features">
<li>Everything in OSS — same local-first model</li>
<li>Managed sync across laptops, CI, and teammates</li>
<li>Cloud accounts, API keys, and billing portal</li>
<li>Device login and team onboarding</li>
<li>No <code>dim serve</code> to run or maintain</li>
<li>Works with any MCP client</li>
</ul>

<p class="pricing-cta"><a class="pricing-button pricing-button-primary" href="https://cloud.aidimag.com" target="_blank" rel="noopener noreferrer">Explore aiDimag Cloud</a></p>

</div>

</div>

---

## Commercial OSS license

Organizations with **more than 10 users** (anyone running `dim`, using MCP, or the dashboard in your company) need a **commercial license** under the Elastic License 2.0 — even if you self-host.

We’re not publishing tier tables here. [Open a GitHub issue](https://github.com/anupkhanal/aidimag/issues) with the `licensing` label and we’ll help you get compliant.

---

## FAQ

### What counts as a user?

Anyone who runs `dim`, connects an agent via MCP, or uses the dashboard or IDE extensions in your organization (including affiliates).

### Does free include the full product?

Yes — every OSS feature (CLI, MCP, verification, guardrails, self-hosted sync, local dashboard). What free does **not** include is **managed cloud sync**, the **cloud account portal**, and use **above 10 users** without a commercial license.

### Self-host vs cloud?

| | Self-hosted (free) | aiDimag Cloud |
|---|---|---|
| **Memory** | Local SQLite on each machine | Same — agents still read local SQLite |
| **Sync** | You run `dim serve` | We host sync 24/7 |
| **Ops** | Your server, your backups | Accounts, keys, billing, dashboard |
| **Best for** | ≤10 users, full control | Teams wanting managed sync |

### Can I use it in a commercial product?

Yes, if your organization is within the free user limit. Above 10 users, you need a commercial license regardless of self-host vs cloud.

### Is the source code available?

Yes — [github.com/anupkhanal/aidimag](https://github.com/anupkhanal/aidimag). Read, audit, and contribute under the Elastic License 2.0.

---

## License summary

aiDimag is licensed under the **Elastic License 2.0** with a 10-user Additional Use Grant.

- Use freely for up to 10 users per organization
- Full source available; modify and distribute with license terms
- Cannot offer aiDimag as a managed/hosted service to third parties (use aiDimag Cloud for that)
- 11+ users require a commercial license

[Read the full license →](https://github.com/anupkhanal/aidimag/blob/main/LICENSE)
