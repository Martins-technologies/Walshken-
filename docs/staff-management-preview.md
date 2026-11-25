# Walshken staff management preview

This is the implementation and acceptance guide for branch `codex/walshken-role-qa`. The branch keeps the existing QA staff data and carries the public pages and assets from live commit `692eeede2371c1bdecbd662b8eb7d9eeb09d4e1a`. Production deployment and database changes require separate release approval.

## Where to test

| Area | Test path | Expected result |
| --- | --- | --- |
| Departments and teams | Departments → Manage unit | Super Admin can add secondary departments and teams. An employee’s primary department stays attached through the staff profile. Membership writes are organization-scoped and audited. |
| Direct messaging | Messages → New conversation | An authorized new cross-department conversation needs confirmation. Cancel leaves it unopened. Same/shared department, configured Support and explicit warning exemptions use the appropriate policy. |
| Communication oversight | Messages → Communication management | Filter by employee, department, team or activity. Hide or restore directory entries independently of conversation access. Content review requires its own authority and a reason. |
| Recording | Calls → Recording policy, then a meeting | Select allowed categories, request/start roles, host approval and consent. A refusal or withdrawal under a consent policy blocks or stops recording. Watch the recording indicator and verify retained video playback from an eligible account. |
| Invitations | Calls → Schedule a meeting → External guests | Set the timezone, attendees, instructions and recording options. The delivery list distinguishes queued, blocked, sent and failed messages. External participants use a unique invitation, RSVP and host admission where enabled. Rescheduling invalidates the old invite and queues a replacement. |
| Project assignments | Projects → Create or edit | Choose owner, manager, department, team, assigned employees, date range and priority. Reassignment removes obsolete access and retains prior assignment history. Track assigned milestones, submitted deliverables, independent review and scheduled reminders. |
| Performance | Reports → Staff performance | Filter by month and year, department or employee. Compare the top three, arrival register, punctuality ranking, department aggregates, project completion and trends. Export CSV or PDF with permission. |

## Communication permission matrix

| Role or grant | Directory and direct conversations | Oversight |
| --- | --- | --- |
| Staff | Existing colleague scopes, shared departments and configured Support; confirmation for an eligible cross-department start. | No additional access by default. |
| Configured Support departments | Internal organization-wide discovery and two-way messaging. Group eligibility continues to follow the group’s own scope. | No inherent private-message oversight authority. |
| Admin, HR and departmental managers | Existing colleague scope plus authorized direct grants. | Individual capability grants for directory, metadata, content, activity and employee or team visibility. Scoped reviews cannot expose an out-of-scope author’s retained message. |
| Super Admin | Organization-wide administration and Support designation. | Audited content access and governance. Can delegate oversight by organization, department, division, country, office or employee. |
| External meeting guest | Meeting-only invitation session. | No staff directory, messages, reports or portal access through that session. |

`communication.direct.silent` suppresses confirmation for a permitted peer. Hiding a directory entry affects discovery and leaves accounts and retained history available through their existing authorization rules.

## Recording, external meetings and delivery

The portal checks organization policy, the meeting category, the requesting and starting roles, host approval and required participant consent before requesting real LiveKit Egress. Policy revisions are retained. The in-meeting status follows actual recording state. Stop requests and provider failures remain visible and retryable. Completed recordings use private storage and existing retention. Playback and download require current meeting access and issue expiring access.

An invitation link carries a unique, expiring secret in its URL fragment. The server validates it and issues a meeting-scoped guest session. Host permission, waiting-room rules, invitation revocation and LiveKit media permissions are enforced separately. Queued invitation, reschedule, cancellation and reminder sends use the existing Resend integration and idempotency keys. A host can request authorized processing for that meeting while reviewing the delivery status.

Actual external delivery requires a verified sender on `notify.walshken.com` and the protected send-only Resend credential in the QA Integrations screen. An external browser also needs access to the protected Vercel Preview before it opens the meeting link. Automated tests use isolated provider transports. Live two-device audio/video and Egress recording/playback still need a connected-provider acceptance session.

## Performance scores

Default weights are attendance 35, punctuality 30, timely task completion 20, project completion 5, and milestones 10. Approved review and work-quality assessments are available as separately weighted inputs. An authorized organization-level administrator can publish dated weights totaling 100. The report calculates a rounded weighted mean over measurable factors and discloses the measured weight. Missing required arrival evidence or a missing weighted approved assessment prevents ranking. Completion values use rates from due work and reassignments are deduplicated.

The arrival register uses the published shift, its local timezone, the clock record and configured grace. Approved leave, qualifying holidays, excused shifts and different published schedules are accounted for. Missing check-ins remain distinct from recorded absence. When fewer than three employees have qualifying evidence, the leaderboard shows only those employees. Closed-month finalization saves an immutable organization snapshot and authorized readers see their current scope.

## Database changes

- `20261125231710_staff_unit_memberships.sql` adds tenant-bound team and secondary department membership.
- `20261125232141_communication_directory_governance.sql` adds directory visibility settings and Support department policy.
- `20261126000400_staff_performance_reports.sql` adds weight versions, independent assessments and immutable snapshots.
- `20261126041500_project_assignments_and_deliverables.sql` extends project and milestone fields and adds assignment history, deliverables, versions and reminder receipts.
- `20261126045000_management_meeting_invitations.sql` adds external guest records, presence and an invitation email queue.
- `20261126090100_meeting_recording_policy.sql` adds recording policy revisions, host approval requests and recording stop tracking.
- `20261126091500_staff_meeting_internal_reminders.sql` adds internal reminder receipts.

The preview grants in `ops/preview/management-runtime-grants.sql` apply only to `walshken_role_qa`. New tables use row-level security. The QA app role cannot read production employee data and the production role cannot use the QA schema. To roll back the preview app, redeploy the previous QA commit and leave the additive tables intact so QA records are preserved.

## Verification scope

The isolated test runner exercises staff team membership, messaging governance and warning behavior, recording and invitation authorization and transitions, project assignments/deliverables/reminders, performance ranking, arrival and export rules, and the existing portal regressions. Chromium checks verify the confirmation and cancel behavior. Provider mocks test actual application routes and request contracts. The QA scanner requirement remains in effect for new private deliverables, which require a clean verdict from a configured scanner.
