import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {maintenanceAuthorized} from "../lib/walshken/maintenance-auth.ts";

const secret="isolated-fixture-secret";
const epoch=1795660000000;
const signed=seconds=>`WalshkenQACron ${seconds}.${createHmac("sha256",secret)
  .update(`walshken-management-maintenance:${seconds}`).digest("hex")}`;
assert.equal(maintenanceAuthorized(`Bearer ${secret}`,secret,false,epoch),true);
assert.equal(maintenanceAuthorized(signed(epoch/1000),secret,true,epoch),true);
assert.equal(maintenanceAuthorized(signed(epoch/1000),secret,false,epoch),false);
assert.equal(maintenanceAuthorized(signed(epoch/1000-90),secret,true,epoch),false);
assert.equal(maintenanceAuthorized(signed(epoch/1000+90),secret,true,epoch),false);
assert.equal(maintenanceAuthorized(signed(epoch/1000),"different-secret",true,epoch),false);
assert.equal(maintenanceAuthorized(`Bearer ${"x".repeat(513)}`,secret,true,epoch),false);
console.log("PASS signed QA scheduling, short expiry and production rejection");
