# Platforms: read-only access

Use a Kortix connector when one is connected for the platform: it holds the
login, and its policy keeps writes behind an approval. Without one, use the
platform's API with the read-only credential named here. Read the vendor docs
once when a call is rejected; field names change between API versions.

| Platform | Connector first | API fallback, read-only | Secret names |
| --- | --- | --- | --- |
| Google Ads | `google_ads` | Google Ads API reports (GAQL `SELECT … FROM campaign` with `metrics.cost_micros`, `metrics.conversions`) | `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` |
| Meta Ads | `facebook_ads` | Marketing API Insights (`/act_<id>/insights` with `level=campaign`) | `META_ADS_ACCESS_TOKEN`, `META_ADS_ACCOUNT_ID` |
| LinkedIn Ads | `linkedin_ads` | Marketing API ad analytics (`adAnalytics` with `pivot=CAMPAIGN`) | `LINKEDIN_ADS_ACCESS_TOKEN`, `LINKEDIN_ADS_ACCOUNT_ID` |
| Conversions | the analytics connector | PostHog or GA4 query for the conversion events in `marketing.json` | `POSTHOG_API_KEY` or `GA4_PROPERTY_ID` + a service-account key |

A token with write scope is refused: check its scopes once per run when the
platform reports them, and stop with `errors=write-scoped-token` if it can write.
