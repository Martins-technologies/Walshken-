ALTER TABLE staff_leave_adjustments ADD COLUMN carry_basis text;
ALTER TABLE staff_leave_adjustments ADD CONSTRAINT staff_leave_carry_basis_kind
  CHECK (carry_basis IS NULL OR kind = 'Carry forward');
