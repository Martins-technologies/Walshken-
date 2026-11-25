# Finance and payroll policy controls

## Owner's requested behavior

Government jurisdiction values are references and starting values. Authorized administrators can choose the company's payroll settings, including zero for supported percentage, rate, contribution, and amount fields. Saving a company setting does not cause the calculation to silently restore a government reference value.

For example, an employee vacation percentage entered as `0` is a zero-percent company setting. It is distinct from an empty field and from choosing to inherit a jurisdiction policy. A selected `4` or `7.25` is used as that percentage. Changing a company setting does not change the government reference displayed beside it or represent the custom setting as government-approved.

This update supersedes the earlier release report's description of automatic payroll minimums for newly configured company policies. Existing policy versions retain their recorded behavior. Deploying this update does not edit any organization's selected percentages, employee pay rates, opening balances, or finalized payroll.

## Where to make changes

### Payroll → Policies

Use this area for the jurisdiction's company settings. The editor provides country, jurisdiction, category, coverage, effective dates, reference information, and the selected values.

Pay standards have individual fields for vacation percentages, long-service settings, wage references, reporting pay, payment timing, and holiday-pay settings. The tax package editor exposes the supported bracket tables, rates, annual limits, exemptions, credits, and contribution parameters. The same policy workflow supports Canada, India, and Pakistan.

Percentages and decimal rates are different units:

- Vacation percentage `4` means 4%; `0` means 0%.
- A tax or contribution rate `0.0595` means 5.95%; `0` means zero.
- Currency amounts retain the country/package's currency and the period identified in the field.

Read the field's limit label separately from its rate. Some existing contribution ceilings use `0` to mean **uncapped**, while a rate of `0` means no contribution at that rate. Those ceiling conventions remain explicit; changing a ceiling to zero is not a substitute for changing the rate to zero.

Government references can be used to start a new company version. They are displayed separately from the company's edited settings. The source reference, company change reason, effective dates, and review remain attached to the version.

To change a shared policy:

1. Open **Staff → Payroll → Policies**, then choose the country and policy category.
2. Copy an existing version or choose **Create a policy version**. Select the actual worksite jurisdiction.
3. If a maintained reference is available, use **Use reference values as starting values**. Edit the company values independently.
4. Enter coverage, effective dates, a new version name, and the reason for the change.
5. Choose **Save company policy for review**. A separate authorized administrator reviews the version before it becomes applicable.

For overtime, a daily or weekly threshold of `0` disables that threshold. An overtime multiplier of `0` keeps the eligible overtime hours recorded while calculating zero overtime pay. These are separate controls.

### Payroll → Setup → Employee payroll setup

Choose the employee and the source of their policy values:

| Choice | Calculation behavior |
| --- | --- |
| Employee override | Use the selected employee values exactly, including zero. An employee override takes priority over the corresponding jurisdiction setting. |
| Jurisdiction policy | Use the applicable company jurisdiction policy for the effective date. Where no company override exists, retain the supported reference/default behavior. |

The screen identifies which choice is active. Fields controlled by inheritance are disabled while the jurisdiction source is selected, so inactive employee values cannot be mistaken for the values the calculation will use.

### Payroll → Statutory validation

Use the employer settings for employer contribution elections and additional levies. The supported financial values accept zero, including the EI employer multiplier, EPF contribution rate, additional employee/employer levy rates, and selected contribution wage bases. Actual identity, registration, worker membership, effective-date coverage, and independent review remain separate from those editable financial values.

## Authority and review

Super Admin can manage all company finance and payroll policy scopes. Other authorized administrators retain their assigned payroll scope.

A jurisdiction policy can affect many employees, including future employees. Editing it therefore requires the applicable organization-wide or country-wide payroll-rules authority. A department-only or individual-employee grant does not grant authority to change a policy for an entire country. Those administrators can continue editing the employee payroll settings within their own authorized scope.

Explicit permission denials remain effective. Policy review, payroll approval, and finalization are separate from editing the values. A company policy review confirms the company's selection; it does not relabel a custom value as an official government value.

## Effective dates and history

Edits create new effective-dated versions. They retain the selected values, reference information, change reason, and audit trail. Use the new version for the intended effective period, with the existing review workflow.

Previously finalized payroll keeps the policy values and calculation snapshot used at finalization. Editing today's policy does not rewrite an old payslip, alter an old approval, or recalculate a historical payroll silently. Changes to inputs for an unfinalized payroll still require recalculation and the applicable approval.

## Validation that remains

The application still checks valid numbers, supported currencies and methods, ordered bracket thresholds, effective-date coverage, permissions, stale revisions, and calculation integrity. These checks keep the configuration executable and prevent changes outside the administrator's authority.

A zero rate is preserved through validation and calculation. It must not be converted to a default by a truthy/falsy fallback, raised by a hidden minimum, or used as an invalid divisor. Differences from the displayed reference remain visible as company policy information.

The native CAD, INR, and PKR payroll calculators use two decimal places internally. New PKR opening balances record this precision explicitly. If an older rate, nonzero opening, or finalized calculation used a different or ambiguous scale, a new calculation requires a reviewed correction or replacement; it does not reinterpret the saved amount automatically.

## Verification scope

The release regression checks cover explicit zero and custom percentages, jurisdiction inheritance, employee override priority, legacy defaults, zero tax/contribution rates and caps, authority boundaries, and immutable finalized snapshots. The production build also runs the full existing isolated regression gate and verifies the current calling and private-storage connections before release.

Government reference example: [Alberta vacation and vacation-pay guidance](https://www.alberta.ca/vacation-pay). The applicable reference varies by jurisdiction, employee circumstances, and effective date; this guide does not substitute one country's reference for another's.
