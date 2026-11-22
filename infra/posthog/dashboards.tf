# Kortix product-analytics dashboards, as code (EU Cloud project 334925).
#
# Every insight is a PostHog query node (InsightVizNode -> TrendsQuery /
# FunnelsQuery / RetentionQuery / StickinessQuery / LifecycleQuery). Event and
# property names are the server-side contract in
# apps/api/src/shared/product-analytics.ts, plus PostHog's own $pageview.
# Change an event there, change the insight here, in the same PR.
#
# Every query sets filterTestAccounts: the project's test-account filter keeps
# only environment=production and drops Kortix staff and bots.
#
# Layout: one markdown intro tile on top, then insights two per row.

locals {
  last_7d  = { date_from = "-7d" }
  last_30d = { date_from = "-30d" }
  last_90d = { date_from = "-90d" }
  # A completed turn that worked. Failed turns (no model, plan refusal) also fire turn_completed.
  turn_ok = {
    kind       = "EventsNode"
    event      = "turn_completed"
    name       = "turn_completed"
    properties = [{ key = "status", value = ["ok"], operator = "exact", type = "event" }]
  }
  # screen_ready measured from the browser's navigation start (a full page load).
  screen_load = [{ key = "navigation", value = ["load"], operator = "exact", type = "event" }]
  tags        = ["kortix", "terraform"]

  dashboards = {
    activation = {
      name        = "Kortix · Activation"
      description = "Do new users reach a completed agent turn, and how fast?"
      intro       = "## Activation\nSelf-serve: signup → project → model provider (optional) → session → prompt → completed turn, inside 24h. Invited people join a workspace someone else made, so they have their own funnel. A completed turn means `status = ok`. Time to first prompt is the number to move."
      insights = [
        {
          key         = "funnel"
          name        = "Activation funnel, self-serve (24h)"
          description = "user_signed_up (invited ≠ true) → project_created → provider_configured (optional: the Free plan needs one, a paid plan does not) → session_created → prompt_sent → turn_completed (status ok), within 24h."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                {
                  kind  = "EventsNode"
                  event = "user_signed_up"
                  name  = "user_signed_up"
                  # is_not keeps sign-ups from before the property existed.
                  properties = [{ key = "invited", value = ["true"], operator = "is_not", type = "event" }]
                },
                { kind = "EventsNode", event = "project_created", name = "project_created" },
                { kind = "EventsNode", event = "provider_configured", name = "provider_configured", optionalInFunnel = true },
                { kind = "EventsNode", event = "session_created", name = "session_created" },
                { kind = "EventsNode", event = "prompt_sent", name = "prompt_sent" },
                local.turn_ok,
              ]
              funnelsFilter = {
                funnelVizType            = "steps"
                funnelWindowInterval     = 24
                funnelWindowIntervalUnit = "hour"
              }
            }
          }
        },
        {
          key         = "funnel_invited"
          name        = "Activation funnel, invited (24h)"
          description = "member_joined (a person joins a workspace someone else made: invite, auto-claim, direct add, project invite, access request) → session_created → prompt_sent → turn_completed (status ok), within 24h."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                { kind = "EventsNode", event = "member_joined", name = "member_joined" },
                { kind = "EventsNode", event = "session_created", name = "session_created" },
                { kind = "EventsNode", event = "prompt_sent", name = "prompt_sent" },
                local.turn_ok,
              ]
              funnelsFilter = {
                funnelVizType            = "steps"
                funnelWindowInterval     = 24
                funnelWindowIntervalUnit = "hour"
              }
            }
          }
        },
        {
          key         = "signups_by_kind"
          name        = "Signups per day, invited vs self-serve"
          description = "user_signed_up broken down by invited (true = an invitation to the email was open at sign-up; empty = before the property existed)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "user_signed_up", name = "user_signed_up", math = "total" }]
              breakdownFilter    = { breakdown = "invited", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "time_to_first_prompt"
          name        = "Time to first prompt"
          description = "Median time from user_signed_up to the first prompt_sent (7-day window)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                { kind = "EventsNode", event = "user_signed_up", name = "user_signed_up" },
                { kind = "EventsNode", event = "prompt_sent", name = "prompt_sent" },
              ]
              funnelsFilter = {
                funnelVizType            = "time_to_convert"
                funnelWindowInterval     = 7
                funnelWindowIntervalUnit = "day"
                funnelFromStep           = 0
                funnelToStep             = 1
              }
            }
          }
        },
        {
          key         = "signups_by_method"
          name        = "Signups per day by method"
          description = "user_signed_up broken down by method (password, magic link, google, github, …)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "user_signed_up", name = "user_signed_up", math = "total" }]
              breakdownFilter    = { breakdown = "method", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "signups_30d"
          name        = "Signups (30 days)"
          description = "Total user_signed_up in the last 30 days."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "user_signed_up", name = "user_signed_up", math = "total" }]
              trendsFilter       = { display = "BoldNumber" }
            }
          }
        },
        {
          key         = "projects_by_source"
          name        = "Projects created by origin"
          description = "project_created broken down by origin (blank, template, marketplace, github_import)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "project_created", name = "project_created", math = "total" }]
              breakdownFilter    = { breakdown = "origin", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "first_turn_rate"
          name        = "Signup → completed turn (7 days)"
          description = "Share of signups that reach a turn_completed with status ok within 7 days."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [
                { kind = "EventsNode", event = "user_signed_up", name = "user_signed_up" },
                local.turn_ok,
              ]
              funnelsFilter = {
                funnelVizType            = "steps"
                funnelWindowInterval     = 7
                funnelWindowIntervalUnit = "day"
              }
            }
          }
        },
      ]
    }

    setup = {
      name        = "Kortix · Setup"
      description = "Does the setup prompt (/setup.md) end in working loops, how fast, and where does it stop?"
      intro       = "## Setup prompt\nA person copies the prompt (`setup_prompt_copied`, Loopmaxxing), their coding agent follows /setup.md, and the CLI reports each step: `kortix plan` (setup_started), `templates add` (setup_template_added), each `kortix onboard` (setup_onboard_run) and the first green doctor (setup_ready). One setup run = one `setup_id`; `agent` is the coding agent that ran it. The first real run is the first `trigger_fired`. Copies and setups are two separate numbers: a copy on loopmaxxing.sh is an anonymous visitor, and the setup reports as the signed-in person, so PostHog cannot join them."
      insights = [
        {
          key         = "copies_7d"
          name        = "Prompt copies (7 days)"
          description = "setup_prompt_copied in the last 7 days, against the 7 days before. Anonymous visitors on loopmaxxing.sh: compare with setups started, never join them."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_7d
              series             = [{ kind = "EventsNode", event = "setup_prompt_copied", name = "setup_prompt_copied", math = "total" }]
              compareFilter      = { compare = true }
              trendsFilter       = { display = "BoldNumber" }
            }
          }
        },
        {
          key         = "started_7d"
          name        = "Setups started (7 days)"
          description = "setup_started in the last 7 days (one per setup run), against the 7 days before. From a coding agent on a computer or from the Kortix agent in a session."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_7d
              series             = [{ kind = "EventsNode", event = "setup_started", name = "setup_started", math = "total" }]
              compareFilter      = { compare = true }
              trendsFilter       = { display = "BoldNumber" }
            }
          }
        },
        {
          key         = "runs_funnel"
          name        = "Setup runs: started → template → onboard green → ready (7 days)"
          description = "Counted per setup run (setup_id), not per person. The template step is optional: a setup can write its own loops. Onboard green = setup_onboard_run with exit_code 0."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                { kind = "EventsNode", event = "setup_started", name = "setup_started" },
                { kind = "EventsNode", event = "setup_template_added", name = "setup_template_added", optionalInFunnel = true },
                {
                  kind        = "EventsNode"
                  event       = "setup_onboard_run"
                  name        = "setup_onboard_run"
                  custom_name = "onboard green"
                  properties  = [{ key = "exit_code", value = ["0"], operator = "exact", type = "event" }]
                },
                { kind = "EventsNode", event = "setup_ready", name = "setup_ready" },
              ]
              funnelsFilter = {
                funnelVizType            = "steps"
                funnelAggregateByHogQL   = "properties.setup_id"
                funnelWindowInterval     = 7
                funnelWindowIntervalUnit = "day"
              }
            }
          }
        },
        {
          key         = "runs_funnel_by_agent"
          name        = "Setup runs by coding agent (7 days)"
          description = "The same funnel, broken down by agent: claude_code, codex, cursor, gemini, opencode, copilot, kortix (the Kortix agent in a session a person started), other, none (a person in a terminal)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                { kind = "EventsNode", event = "setup_started", name = "setup_started" },
                {
                  kind        = "EventsNode"
                  event       = "setup_onboard_run"
                  name        = "setup_onboard_run"
                  custom_name = "onboard green"
                  properties  = [{ key = "exit_code", value = ["0"], operator = "exact", type = "event" }]
                },
                { kind = "EventsNode", event = "setup_ready", name = "setup_ready" },
              ]
              breakdownFilter = { breakdown = "agent", breakdown_type = "event" }
              funnelsFilter = {
                funnelVizType            = "steps"
                funnelAggregateByHogQL   = "properties.setup_id"
                funnelWindowInterval     = 7
                funnelWindowIntervalUnit = "day"
              }
            }
          }
        },
        {
          key         = "people_funnel"
          name        = "Setup started → ready → first real run, per person (7 days)"
          description = "Per person: the person whose CLI started the setup (for the Kortix agent, the person who started the session). The first real run is the account's first trigger_fired."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                { kind = "EventsNode", event = "setup_started", name = "setup_started" },
                { kind = "EventsNode", event = "setup_ready", name = "setup_ready" },
                { kind = "EventsNode", event = "trigger_fired", name = "trigger_fired" },
              ]
              funnelsFilter = {
                funnelVizType            = "steps"
                funnelWindowInterval     = 7
                funnelWindowIntervalUnit = "day"
              }
            }
          }
        },
        {
          key         = "copies"
          name        = "Prompt copies per day, by template"
          description = "setup_prompt_copied per day. template = the template the prompt names, none = the general prompt."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "setup_prompt_copied", name = "setup_prompt_copied", math = "total" }]
              breakdownFilter    = { breakdown = "template", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "started_by_agent"
          name        = "Setups started per day, by coding agent"
          description = "setup_started per day (one per setup run), broken down by agent."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "setup_started", name = "setup_started", math = "total" }]
              breakdownFilter    = { breakdown = "agent", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "time_to_ready"
          name        = "Minutes from start to ready, median / p90"
          description = "setup_ready.minutes_since_start per week: kortix plan to the first green doctor."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series = [
                { kind = "EventsNode", event = "setup_ready", name = "setup_ready", math = "median", math_property = "minutes_since_start", custom_name = "median" },
                { kind = "EventsNode", event = "setup_ready", name = "setup_ready", math = "p90", math_property = "minutes_since_start", custom_name = "p90" },
              ]
            }
          }
        },
        {
          key         = "onboard_exit"
          name        = "Onboard runs by exit code"
          description = "setup_onboard_run per day. 0 = done and green, 4 = the person still has steps on the setup page, 1 = a phase failed."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "setup_onboard_run", name = "setup_onboard_run", math = "total" }]
              breakdownFilter    = { breakdown = "exit_code", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "onboard_stops"
          name        = "Where onboard stops: phases that wait or fail"
          description = "setup_onboard_run events whose phase_<name> is waiting_on_person or failed, one series per phase, last 30 days."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "week"
              series = [for phase in ["ship", "secrets", "webhooks", "slack", "connectors", "sandbox", "doctor"] : {
                kind        = "EventsNode"
                event       = "setup_onboard_run"
                name        = "setup_onboard_run"
                custom_name = phase
                math        = "total"
                properties  = [{ key = "phase_${phase}", value = ["waiting_on_person", "failed"], operator = "exact", type = "event" }]
              }]
              trendsFilter = { display = "ActionsBarValue" }
            }
          }
        },
      ]
    }

    engagement = {
      name        = "Kortix · Engagement"
      description = "How many people use Kortix, how often, and do they come back?"
      intro       = "## Engagement\nTwo definitions side by side: *logged-in active* (any event) and *productive active* (prompt_sent). Retention and stickiness use prompt_sent."
      insights = [
        {
          key         = "active_users_any"
          name        = "DAU / WAU / MAU — any event"
          description = "Unique users with any event, daily / rolling 7-day / rolling 30-day."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                { kind = "EventsNode", event = null, name = "All events", math = "dau", custom_name = "DAU" },
                { kind = "EventsNode", event = null, name = "All events", math = "weekly_active", custom_name = "WAU" },
                { kind = "EventsNode", event = null, name = "All events", math = "monthly_active", custom_name = "MAU" },
              ]
              trendsFilter = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "active_users_prompt"
          name        = "DAU / WAU / MAU — prompt_sent"
          description = "Unique users who sent at least one prompt, daily / rolling 7-day / rolling 30-day."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                { kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "dau", custom_name = "DAU" },
                { kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "weekly_active", custom_name = "WAU" },
                { kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "monthly_active", custom_name = "MAU" },
              ]
              trendsFilter = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "retention_weekly"
          name        = "Weekly retention (prompt_sent)"
          description = "Users whose first prompt was in week N and who prompted again in later weeks."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "RetentionQuery"
              filterTestAccounts = true
              dateRange          = { date_from = "-8w" }
              retentionFilter = {
                retentionType   = "retention_first_time"
                period          = "Week"
                totalIntervals  = 8
                targetEntity    = { id = "prompt_sent", type = "events", name = "prompt_sent" }
                returningEntity = { id = "prompt_sent", type = "events", name = "prompt_sent" }
              }
            }
          }
        },
        {
          key         = "stickiness_prompt"
          name        = "Stickiness (prompt_sent)"
          description = "How many distinct days per month users send prompts."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "StickinessQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "prompt_sent", name = "prompt_sent" }]
            }
          }
        },
        {
          key         = "prompts_per_user_week"
          name        = "Prompts per active user per week"
          description = "Average prompt_sent per user who prompted that week."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series             = [{ kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "avg_count_per_actor" }]
              trendsFilter       = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "surface_mix"
          name        = "Prompts by surface"
          description = "prompt_sent broken down by source (web, cli, slack, teams, telegram, trigger, api)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "total" }]
              breakdownFilter    = { breakdown = "source", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsPie" }
            }
          }
        },
        {
          key         = "lifecycle_prompt"
          name        = "Lifecycle (prompt_sent, weekly)"
          description = "New, returning, resurrecting and dormant prompting users per week."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "LifecycleQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series             = [{ kind = "EventsNode", event = "prompt_sent", name = "prompt_sent" }]
            }
          }
        },
        {
          key         = "pageviews"
          name        = "Page views per day"
          description = "PostHog $pageview, all routes."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "total" }]
              trendsFilter       = { display = "ActionsLineGraph" }
            }
          }
        },
      ]
    }

    providers_models = {
      name        = "Kortix · Providers & models"
      description = "Which LLM providers people connect, whether the keys work, and which models they prompt."
      intro       = "## Providers & models\nprovider_configured / provider_verified come from project secrets and the gateway key check; the model is a property on every prompt_sent."
      insights = [
        {
          key         = "provider_configured"
          name        = "Providers configured"
          description = "provider_configured broken down by provider (anthropic, openai, openrouter, bedrock, groq, opencode)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "provider_configured", name = "provider_configured", math = "total" }]
              breakdownFilter    = { breakdown = "provider", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "provider_method"
          name        = "Provider setup method"
          description = "provider_configured by method (api_key vs oauth)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "provider_configured", name = "provider_configured", math = "total" }]
              breakdownFilter    = { breakdown = "method", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsPie" }
            }
          }
        },
        {
          key         = "provider_verified"
          name        = "Provider key checks by state"
          description = "provider_verified by state (verified, invalid, not_connected, unknown)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "provider_verified", name = "provider_verified", math = "total" }]
              breakdownFilter    = { breakdown = "state", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsPie" }
            }
          }
        },
        {
          key         = "prompts_by_model"
          name        = "Prompts by model"
          description = "prompt_sent broken down by model."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "total" }]
              breakdownFilter    = { breakdown = "model", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "users_by_model"
          name        = "Unique users by model"
          description = "Daily unique users sending prompts, broken down by model."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "prompt_sent", name = "prompt_sent", math = "dau" }]
              breakdownFilter    = { breakdown = "model", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "model_changed"
          name        = "Model switches"
          description = "model_changed per day, broken down by the model switched to."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "model_changed", name = "model_changed", math = "total" }]
              breakdownFilter    = { breakdown = "to", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
      ]
    }

    sessions = {
      name        = "Kortix · Sessions"
      description = "Sandbox boots, boot latency, how long sessions stay active, and turn outcomes."
      intro       = "## Sessions\nsession_started fires once per boot (first open, wake after sleep, restart), so it counts boots, not sessions; session_created counts sessions. boot_ms is measured at /start; active_ms is stamped when a session stops (user, idle reaper, restart). Turn outcomes come from turn_completed.status."
      insights = [
        {
          key         = "started_by_provider"
          name        = "Sandbox boots by provider"
          description = "session_started per day, broken down by provider. One event per boot: first open, wake after sleep, restart."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "session_started", name = "session_started", math = "total" }]
              breakdownFilter    = { breakdown = "provider", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "boot_ms"
          name        = "Boot time median / p90 (ms)"
          description = "session_started.boot_ms percentiles per day (PostHog offers median, p75, p90, p99 — no p50/p95)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                { kind = "EventsNode", event = "session_started", name = "session_started", math = "median", math_property = "boot_ms", custom_name = "median" },
                { kind = "EventsNode", event = "session_started", name = "session_started", math = "p90", math_property = "boot_ms", custom_name = "p90" },
              ]
              trendsFilter = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "active_ms"
          name        = "Average session active time by stop reason (ms)"
          description = "avg(session_stopped.active_ms) per day, broken down by reason (user, idle, restart)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "session_stopped", name = "session_stopped", math = "avg", math_property = "active_ms" }]
              breakdownFilter    = { breakdown = "reason", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "turn_status"
          name        = "Turn outcomes"
          description = "turn_completed by status (ok, error, aborted)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "turn_completed", name = "turn_completed", math = "total" }]
              breakdownFilter    = { breakdown = "status", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "turn_error_rate"
          name        = "Turn error rate (%)"
          description = "turn_completed with status=error divided by all turn_completed, per day."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                {
                  kind       = "EventsNode"
                  event      = "turn_completed"
                  name       = "turn_completed"
                  math       = "total"
                  properties = [{ key = "status", value = ["error"], operator = "exact", type = "event" }]
                },
                { kind = "EventsNode", event = "turn_completed", name = "turn_completed", math = "total" },
              ]
              trendsFilter = { display = "ActionsLineGraph", formula = "A/B*100" }
            }
          }
        },
        {
          key         = "turns_per_session"
          name        = "Turns per session (weekly)"
          description = "turn_completed divided by session_created, per week."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series = [
                { kind = "EventsNode", event = "turn_completed", name = "turn_completed", math = "total" },
                { kind = "EventsNode", event = "session_created", name = "session_created", math = "total" },
              ]
              trendsFilter = { display = "ActionsLineGraph", formula = "A/B" }
            }
          }
        },
        {
          key         = "stops_by_reason"
          name        = "Session stops by reason"
          description = "session_stopped per day by reason."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "session_stopped", name = "session_stopped", math = "total" }]
              breakdownFilter    = { breakdown = "reason", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
      ]
    }

    adoption = {
      name        = "Kortix · Setup & adoption"
      description = "Which capabilities accounts actually wire up, and where billing gates bite."
      intro       = "## Setup & adoption\nConnectors, secrets, triggers, apps, feature flags, and the billing funnel. One row per capability."
      insights = [
        {
          key         = "connectors"
          name        = "Connectors connected"
          description = "connector_connected per week by provider (composio, mcp, …). The connector slug is a customer-chosen name and is never sent."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "connector_connected", name = "connector_connected", math = "total" }]
              breakdownFilter    = { breakdown = "provider", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "secrets"
          name        = "Secrets created by kind"
          description = "secret_created broken down by name_kind (provider key vs other). Names and values are never sent."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "secret_created", name = "secret_created", math = "total" }]
              breakdownFilter    = { breakdown = "name_kind", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "triggers"
          name        = "Triggers created and fired"
          description = "trigger_created and trigger_fired per day."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                { kind = "EventsNode", event = "trigger_created", name = "trigger_created", math = "total" },
                { kind = "EventsNode", event = "trigger_fired", name = "trigger_fired", math = "total" },
              ]
              trendsFilter = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "apps"
          name        = "Apps deployed by kind"
          description = "app_deployed broken down by app_kind."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "app_deployed", name = "app_deployed", math = "total" }]
              breakdownFilter    = { breakdown = "app_kind", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "feature_flags"
          name        = "Feature flags toggled"
          description = "feature_flag_toggled broken down by key."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "feature_flag_toggled", name = "feature_flag_toggled", math = "total" }]
              breakdownFilter    = { breakdown = "key", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "billing_gate"
          name        = "Billing gate hits by reason"
          description = "billing_gate_hit (HTTP 402) broken down by reason."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "billing_gate_hit", name = "billing_gate_hit", math = "total" }]
              breakdownFilter    = { breakdown = "reason", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "billing_funnel"
          name        = "Checkout → subscription"
          description = "checkout_started, subscription_activated and subscription_cancelled per week, by tier."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series = [
                { kind = "EventsNode", event = "checkout_started", name = "checkout_started", math = "total" },
                { kind = "EventsNode", event = "subscription_activated", name = "subscription_activated", math = "total" },
                { kind = "EventsNode", event = "subscription_cancelled", name = "subscription_cancelled", math = "total" },
              ]
              breakdownFilter = { breakdown = "tier", breakdown_type = "event" }
              trendsFilter    = { display = "ActionsBar" }
            }
          }
        },
        {
          key         = "topups"
          name        = "Credits topped up (USD, weekly)"
          description = "sum(credits_topped_up.amount_usd) per week."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series             = [{ kind = "EventsNode", event = "credits_topped_up", name = "credits_topped_up", math = "sum", math_property = "amount_usd" }]
              trendsFilter       = { display = "ActionsBar" }
            }
          }
        },
      ]
    }

    acquisition = {
      name        = "Kortix · Acquisition"
      description = "Where visitors come from, what they land on, and how many become users."
      intro       = "## Acquisition\nVisitors by day and by source (referrer, UTM), landing pages and bounce from the sessions table, first-touch source of signups, and the visitor → signup rate. Client-side `$pageview` joins server-side `user_signed_up` through identify."
      insights = [
        {
          key         = "visitors"
          name        = "Visitors and pageviews per day"
          description = "Unique visitors (DAU on $pageview) and total pageviews."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                { kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau", custom_name = "Unique visitors" },
                { kind = "EventsNode", event = "$pageview", name = "$pageview", math = "total", custom_name = "Pageviews" },
              ]
            }
          }
        },
        {
          key         = "referrers"
          name        = "Visitors by referring domain"
          description = "Unique visitors in the last 30 days, split by $referring_domain."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
              breakdownFilter    = { breakdown = "$referring_domain", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "utm_source"
          name        = "Visitors by UTM source"
          description = "Unique visitors in the last 30 days, split by utm_source (PostHog captures UTM parameters on every pageview)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
              breakdownFilter    = { breakdown = "utm_source", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "utm_campaign"
          name        = "Visitors by UTM campaign"
          description = "Unique visitors in the last 30 days, split by utm_campaign."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "$pageview", name = "$pageview", math = "dau" }]
              breakdownFilter    = { breakdown = "utm_campaign", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "landing_pages"
          name        = "Landing pages"
          description = "Sessions per entry path with bounce rate, last 30 days (sessions table)."
          query = {
            kind = "DataTableNode"
            source = {
              kind  = "HogQLQuery"
              query = "SELECT $entry_pathname AS landing_path, count() AS sessions, round(100 * avg($is_bounce), 1) AS bounce_pct FROM sessions WHERE $start_timestamp >= now() - INTERVAL 30 DAY AND $entry_current_url LIKE 'https://kortix.com/%' GROUP BY landing_path ORDER BY sessions DESC LIMIT 25"
            }
          }
        },
        {
          key         = "session_quality"
          name        = "Sessions, bounce rate and duration per day"
          description = "Browser sessions per day with bounce rate (%) and average duration (seconds)."
          query = {
            kind = "DataTableNode"
            source = {
              kind  = "HogQLQuery"
              query = "SELECT toStartOfDay($start_timestamp) AS day, count() AS sessions, round(100 * avg($is_bounce), 1) AS bounce_pct, round(avg($session_duration)) AS avg_duration_s FROM sessions WHERE $start_timestamp >= now() - INTERVAL 30 DAY AND $entry_current_url LIKE 'https://kortix.com/%' GROUP BY day ORDER BY day"
            }
          }
        },
        {
          key         = "signups_first_touch"
          name        = "Signups by first-touch UTM source"
          description = "user_signed_up split by the person's $initial_utm_source (set from the first pageview)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series             = [{ kind = "EventsNode", event = "user_signed_up", name = "user_signed_up", math = "total" }]
              breakdownFilter    = { breakdown = "$initial_utm_source", breakdown_type = "person" }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "self_reported_source"
          name        = "Self-reported source (survey)"
          description = "Answers to the survey \"How did you hear about Kortix?\" (new users, first 7 days). Catches $direct visitors who saw a video or ad."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [{
                kind       = "EventsNode"
                event      = "survey sent"
                name       = "survey sent"
                math       = "dau"
                properties = [{ key = "$survey_id", value = "01a1a79a-6d15-0000-cbf7-34ef57802c22", operator = "exact", type = "event" }]
              }]
              breakdownFilter = { breakdown = "$survey_response_709452a5-5925-4704-a85a-0618d2f78ed3", breakdown_type = "event" }
              trendsFilter    = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "visitor_to_signup"
          name        = "Visitor → signup (7-day window)"
          description = "Unique visitors who created an account within 7 days of their first pageview."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              series = [
                { kind = "EventsNode", event = "$pageview", name = "$pageview" },
                { kind = "EventsNode", event = "user_signed_up", name = "user_signed_up" },
              ]
              funnelsFilter = { funnelVizType = "steps", funnelWindowInterval = 7, funnelWindowIntervalUnit = "day" }
            }
          }
        },
      ]
    }

    conversion = {
      name        = "Kortix · Conversion"
      description = "Conversion goals (signed up, activated, subscribed, topped up) and the funnels between them."
      intro       = "## Conversion\nGoals are PostHog actions (Data → Actions, also selectable as Web analytics conversion goals): **Signed up**, **Activated** (first prompt), **Subscribed**, **Topped up**. Funnels count unique people; the window is stated per tile."
      insights = [
        {
          key         = "goals_per_day"
          name        = "Conversion goals per day"
          description = "People reaching each goal per day."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = [
                { kind = "ActionsNode", id = posthog_action.goal["signed_up"].id, name = "Signed up", math = "dau" },
                { kind = "ActionsNode", id = posthog_action.goal["activated"].id, name = "Activated", math = "dau" },
                { kind = "ActionsNode", id = posthog_action.goal["subscribed"].id, name = "Subscribed", math = "dau" },
                { kind = "ActionsNode", id = posthog_action.goal["topped_up"].id, name = "Topped up", math = "dau" },
              ]
            }
          }
        },
        {
          key         = "visitor_to_paid"
          name        = "Visitor → signed up → activated → subscribed (30-day window)"
          description = "The whole conversion path, unique people, 30-day window from the first pageview."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [
                { kind = "EventsNode", event = "$pageview", name = "$pageview" },
                { kind = "ActionsNode", id = posthog_action.goal["signed_up"].id, name = "Signed up" },
                { kind = "ActionsNode", id = posthog_action.goal["activated"].id, name = "Activated" },
                { kind = "ActionsNode", id = posthog_action.goal["subscribed"].id, name = "Subscribed" },
              ]
              funnelsFilter = { funnelVizType = "steps", funnelWindowInterval = 30, funnelWindowIntervalUnit = "day" }
            }
          }
        },
        {
          key         = "signup_to_paid_trend"
          name        = "Signed up → subscribed conversion rate over time"
          description = "Weekly conversion rate from signup to an active subscription (30-day window)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series = [
                { kind = "ActionsNode", id = posthog_action.goal["signed_up"].id, name = "Signed up" },
                { kind = "ActionsNode", id = posthog_action.goal["subscribed"].id, name = "Subscribed" },
              ]
              funnelsFilter = { funnelVizType = "trends", funnelWindowInterval = 30, funnelWindowIntervalUnit = "day" }
            }
          }
        },
        {
          key         = "activated_to_paid"
          name        = "Signed up → activated → subscribed"
          description = "Does activation (a first prompt) precede paying? Compare the drop-off at each step."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [
                { kind = "ActionsNode", id = posthog_action.goal["signed_up"].id, name = "Signed up" },
                { kind = "ActionsNode", id = posthog_action.goal["activated"].id, name = "Activated" },
                { kind = "ActionsNode", id = posthog_action.goal["subscribed"].id, name = "Subscribed" },
              ]
              funnelsFilter = { funnelVizType = "steps", funnelWindowInterval = 30, funnelWindowIntervalUnit = "day" }
            }
          }
        },
        {
          key         = "checkout_by_tier"
          name        = "Checkout started → subscription activated, by tier"
          description = "Checkout completion rate per tier (7-day window)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [
                { kind = "EventsNode", event = "checkout_started", name = "checkout_started" },
                { kind = "EventsNode", event = "subscription_activated", name = "subscription_activated" },
              ]
              breakdownFilter = { breakdown = "tier", breakdown_type = "event" }
              funnelsFilter   = { funnelVizType = "steps", funnelWindowInterval = 7, funnelWindowIntervalUnit = "day" }
            }
          }
        },
        {
          key         = "gate_to_topup"
          name        = "Billing gate hit → credits topped up (7-day window)"
          description = "How often a 402 turns into a purchase."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [
                { kind = "EventsNode", event = "billing_gate_hit", name = "billing_gate_hit" },
                { kind = "ActionsNode", id = posthog_action.goal["topped_up"].id, name = "Topped up" },
              ]
              funnelsFilter = { funnelVizType = "steps", funnelWindowInterval = 7, funnelWindowIntervalUnit = "day" }
            }
          }
        },
        {
          key         = "time_to_paid"
          name        = "Time from signup to subscription"
          description = "Distribution of the time between signup and the first active subscription (90-day window)."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "FunnelsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              series = [
                { kind = "ActionsNode", id = posthog_action.goal["signed_up"].id, name = "Signed up" },
                { kind = "ActionsNode", id = posthog_action.goal["subscribed"].id, name = "Subscribed" },
              ]
              funnelsFilter = {
                funnelVizType            = "time_to_convert"
                funnelWindowInterval     = 90
                funnelWindowIntervalUnit = "day"
                funnelFromStep           = 0
                funnelToStep             = 1
              }
            }
          }
        },
        {
          key         = "revenue_events"
          name        = "Subscriptions, top-ups and cancellations per week"
          description = "Counts of subscription_activated, credits_topped_up and subscription_cancelled."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series = [
                { kind = "EventsNode", event = "subscription_activated", name = "subscription_activated", math = "total" },
                { kind = "EventsNode", event = "credits_topped_up", name = "credits_topped_up", math = "total" },
                { kind = "EventsNode", event = "subscription_cancelled", name = "subscription_cancelled", math = "total" },
              ]
              trendsFilter = { display = "ActionsBar" }
            }
          }
        },
      ]
    }

    speed = {
      name        = "Kortix · Speed"
      description = "How long screens take to show their data, by continent, country and screen."
      intro       = "## Speed\nscreen_ready fires once per navigation when a screen shows its data: the React Query reads behind it settled (no request for 0.5 s), or, on the session screen, the saved conversation is visible. `load` counts from the browser's navigation start (HTML, JS, sign-in and API reads); `route` counts from an in-app route change. The API and the database run in London, so the gap between continents is the cost of distance times the number of sequential API rounds. p75 is the number to hold steady everywhere."
      insights = [
        {
          key         = "ready_by_continent"
          name        = "Page load to data shown, p75 by continent (ms)"
          description = "p75 of screen_ready.duration_ms for page loads (navigation = load), per week, by GeoIP continent."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series             = [{ kind = "EventsNode", event = "screen_ready", name = "screen_ready", math = "p75", math_property = "duration_ms", properties = local.screen_load }]
              breakdownFilter    = { breakdown = "$geoip_continent_name", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "ready_by_country"
          name        = "Page load to data shown, p75 by country (ms, 30 days)"
          description = "p75 of screen_ready.duration_ms for page loads over 30 days, top 25 GeoIP countries."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "screen_ready", name = "screen_ready", math = "p75", math_property = "duration_ms", properties = local.screen_load }]
              breakdownFilter    = { breakdown = "$geoip_country_name", breakdown_type = "event", breakdown_limit = 25 }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "home_session_daily"
          name        = "Workspace home and session, p75 / p90 by day (ms, page loads)"
          description = "screen_ready.duration_ms percentiles for page loads of the two screens people open most."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series = flatten([for screen in [
                { path = "/workspaces/:id", label = "home" },
                { path = "/workspaces/:id/sessions/:id", label = "session" },
                ] : [for pct in ["p75", "p90"] : {
                  kind          = "EventsNode"
                  event         = "screen_ready"
                  name          = "screen_ready"
                  custom_name   = "${screen.label} ${pct}"
                  math          = pct
                  math_property = "duration_ms"
                  properties    = concat(local.screen_load, [{ key = "screen", value = [screen.path], operator = "exact", type = "event" }])
              }]])
              trendsFilter = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "ready_by_screen"
          name        = "Page load to data shown, p75 by screen (ms, 30 days)"
          description = "p75 of screen_ready.duration_ms for page loads over 30 days, by route template."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "screen_ready", name = "screen_ready", math = "p75", math_property = "duration_ms", properties = local.screen_load }]
              breakdownFilter    = { breakdown = "screen", breakdown_type = "event", breakdown_limit = 25 }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
        {
          key         = "route_by_continent"
          name        = "In-app navigation to data shown, p75 by continent (ms)"
          description = "p75 of screen_ready.duration_ms for in-app route changes (navigation = route), per week, by GeoIP continent. Cached screens send no event."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_90d
              interval           = "week"
              series             = [{ kind = "EventsNode", event = "screen_ready", name = "screen_ready", math = "p75", math_property = "duration_ms", properties = [{ key = "navigation", value = ["route"], operator = "exact", type = "event" }] }]
              breakdownFilter    = { breakdown = "$geoip_continent_name", breakdown_type = "event" }
              trendsFilter       = { display = "ActionsLineGraph" }
            }
          }
        },
        {
          key         = "fetches_by_screen"
          name        = "API reads per page load, median by screen (30 days)"
          description = "Median screen_ready.fetches (React Query fetches until the screen settled) for page loads, by route template."
          query = {
            kind = "InsightVizNode"
            source = {
              kind               = "TrendsQuery"
              filterTestAccounts = true
              dateRange          = local.last_30d
              interval           = "day"
              series             = [{ kind = "EventsNode", event = "screen_ready", name = "screen_ready", math = "median", math_property = "fetches", properties = local.screen_load }]
              breakdownFilter    = { breakdown = "screen", breakdown_type = "event", breakdown_limit = 25 }
              trendsFilter       = { display = "ActionsBarValue" }
            }
          }
        },
      ]
    }
  }

  # Conversion goals: PostHog actions, one event each. Reused by the Conversion
  # dashboard (ActionsNode) and selectable as Web analytics conversion goals.
  goals = {
    signed_up  = { name = "Goal · Signed up", description = "A person created their account (user_signed_up).", event = "user_signed_up" }
    activated  = { name = "Goal · Activated", description = "A person sent their first prompt (prompt_sent).", event = "prompt_sent" }
    subscribed = { name = "Goal · Subscribed", description = "A subscription became active (subscription_activated).", event = "subscription_activated" }
    topped_up  = { name = "Goal · Topped up", description = "Credits were purchased (credits_topped_up).", event = "credits_topped_up" }
  }

  # "<dashboard>/<insight key>" => insight + its dashboard and position.
  insights = merge([
    for dk, d in local.dashboards : {
      for i, ins in d.insights : "${dk}/${ins.key}" => merge(ins, { dashboard = dk, index = i })
    }
  ]...)
}

resource "posthog_action" "goal" {
  for_each    = local.goals
  name        = each.value.name
  description = each.value.description
  tags        = local.tags
  steps_json  = jsonencode([{ event = each.value.event }])
}

resource "posthog_dashboard" "this" {
  for_each    = local.dashboards
  name        = each.value.name
  description = each.value.description
  pinned      = true
  tags        = local.tags
}

resource "posthog_insight" "this" {
  for_each      = local.insights
  name          = each.value.name
  description   = each.value.description
  query_json    = jsonencode(each.value.query)
  dashboard_ids = [posthog_dashboard.this[each.value.dashboard].id]
  tags          = local.tags
}

resource "posthog_dashboard_layout" "this" {
  for_each     = local.dashboards
  dashboard_id = posthog_dashboard.this[each.key].id

  tiles = concat(
    [{
      text_body        = each.value.intro
      insight_id       = null
      color            = null
      show_description = null
      layouts_json     = jsonencode({ sm = { x = 0, y = 0, w = 12, h = 2 } })
    }],
    [for i, ins in each.value.insights : {
      insight_id       = posthog_insight.this["${each.key}/${ins.key}"].id
      text_body        = null
      color            = null
      show_description = true
      layouts_json     = jsonencode({ sm = { x = (i % 2) * 6, y = 2 + floor(i / 2) * 5, w = 6, h = 5 } })
    }],
  )
}

output "dashboards" {
  description = "Dashboard name => id"
  value       = { for k, d in posthog_dashboard.this : d.name => d.id }
}
