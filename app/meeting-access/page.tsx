import type {Metadata} from "next";
import {GuestMeetingAccess} from "@/components/walshken/guest-meeting-access";
export const metadata:Metadata={
  title:"Meeting access",
  robots:{index:false,follow:false},
  referrer:"no-referrer",
};
export default function MeetingAccessPage() { return <GuestMeetingAccess/>; }
