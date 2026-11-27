# Addendum: sessions, live view and multi-person journeys

Extends *Complao Action Log Portal: Requirements and Acceptance Criteria* (13 Nov 2026). Numbering continues from R21.

## Why

The portal answers "what happened in this action?" well. Founders also need to see **what is happening right now** across many audits in parallel, where each audit has several people in different roles (auditor, TIC, CB, admin) signing in and taking turns. And they need to follow **one person's visit** from login to logout.

Two links on every action make this possible:

- **Session ID**: everything *one person* did between signing in and signing out.
- **Case ID**: everything *anyone* did on one audit or registration (already in Appendix A).

## Changes to Appendix A (log event)

| Field | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string, ≤128 chars | On every event from a signed-in user | Created at login by the auth layer (for example the session or token ID). The same value on every event until logout or expiry. |
| `actor_role` | string, ≤64 chars | On every event | The role the person is acting in: `Auditor`, `TIC`, `CB`, `Admin`. A code, not a name. |

Login and logout are ordinary actions with `action_type` `Login` and `Logout`. Both fields are IDs and codes, so R3 (no personal data) still holds.

## Requirements

### R22 Sessions

Every sign-in is a session. The portal lists sessions and shows each one in full.

Acceptance criteria:

1. A person who signs in, works on two cases and signs out appears as one session with every action in time order, the cases they touched, and how many actions failed.
2. A session shows **Active** while actions keep arriving, **Idle** after 5 minutes with none, **Signed out** after a logout, and **Expired** after 30 minutes with no logout. Both limits are set in Settings.
3. Sessions can be filtered by status, role, person and date.
4. Gaps longer than a minute between actions in a session are shown ("Nothing for 12 min").

### R23 Live view

One page shows everything happening across Complao in the last 15 minutes to 2 hours: grouped by case, one lane per person, one bar per action.

Acceptance criteria:

1. With five audits in progress, each with several people, all five appear with a lane for every person who acted in the window.
2. A bar's length is the action's duration. A running action reaches "now" and grows until it ends. Failed actions are red, partial ones amber.
3. Sign-ins and sign-outs are shown in the lane of each case the session went on to touch. Activity that touched no case is grouped under "Other activity".
4. Cases with a problem (a failed, partial or stalled action) are listed first.
5. Selecting any bar shows that action's full step tree, including the failing step and its error, without leaving the page. From there you can open the person's session or the case journey.
6. Updates pause while the pointer is over the timeline, so bars don't move while you're selecting one.
7. New activity appears after the next log pull (within one pull interval).

### R24 Multi-person journeys

The case journey (R18) shows everyone who worked on the case.

Acceptance criteria:

1. An audit worked on by an auditor, a TIC, a CB and an admin across four sessions shows four lanes, each with that person's actions and sign-ins.
2. Selecting a bar opens that action's step tree; selecting a name opens that person's session.

## Data and design notes

- The action store gains a session record per sign-in (start, last activity, sign-out, actions, cases, failures) and an index from session to its actions (`gsi4`). The infrastructure template includes the index.
- Live reads the last window's actions and sessions by day, so it stays a keyed read like every other view (section 6.4).
- "Live" means as fresh as the log pull. At the 30-second setting, actions appear within about 30 to 60 seconds. Second-by-second updates would need a CloudWatch subscription instead of the scheduled pull; that is out of scope here.
