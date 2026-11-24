export const employmentCategoryNames = ["Work", "Overtime", "Holiday calendar", "Leave", "Canada Alberta payroll", "Canada payroll", "India payroll", "Pakistan payroll", "Pay standards", "Evidence"] as const;
export type EmploymentCategory = typeof employmentCategoryNames[number];
export const employmentEngineEnabled = () => process.env.WALSHKEN_EMPLOYMENT_ENGINE_ENABLED === "1";
export type Region = {country:string;code:string;name:string;kind:string};

const ca = [
  ["AB","Alberta"],["BC","British Columbia"],["MB","Manitoba"],["NB","New Brunswick"],
  ["NL","Newfoundland and Labrador"],["NS","Nova Scotia"],["ON","Ontario"],["PE","Prince Edward Island"],
  ["QC","Quebec"],["SK","Saskatchewan"],["NT","Northwest Territories"],["NU","Nunavut"],["YT","Yukon"],
];
const indiaStates = [
  ["AP","Andhra Pradesh"],["AR","Arunachal Pradesh"],["AS","Assam"],["BR","Bihar"],
  ["CT","Chhattisgarh"],["GA","Goa"],["GJ","Gujarat"],["HR","Haryana"],["HP","Himachal Pradesh"],
  ["JH","Jharkhand"],["KA","Karnataka"],["KL","Kerala"],["MP","Madhya Pradesh"],["MH","Maharashtra"],
  ["MN","Manipur"],["ML","Meghalaya"],["MZ","Mizoram"],["NL","Nagaland"],["OD","Odisha"],
  ["PB","Punjab"],["RJ","Rajasthan"],["SK","Sikkim"],["TN","Tamil Nadu"],["TS","Telangana"],
  ["TR","Tripura"],["UP","Uttar Pradesh"],["UK","Uttarakhand"],["WB","West Bengal"],
];
const indiaTerritories = [
  ["AN","Andaman and Nicobar Islands"],["CH","Chandigarh"],["DH","Dadra and Nagar Haveli and Daman and Diu"],
  ["DL","Delhi"],["JK","Jammu and Kashmir"],["LA","Ladakh"],["LD","Lakshadweep"],["PY","Puducherry"],
];
const pk = [["PB","Punjab"],["SD","Sindh"],["KP","Khyber Pakhtunkhwa"],["BA","Balochistan"],
  ["IS","Islamabad Capital Territory"],["GB","Gilgit-Baltistan"],["JK","Azad Jammu and Kashmir"]];
export const employmentRegions:Region[] = [
  ...ca.map(([code,name])=>({country:"CA",code:"CA-"+code,name,kind:["NT","NU","YT"].includes(code)?"Territory":"Province"})),
  {country:"CA",code:"CA-FED",name:"Federal employment jurisdiction",kind:"Federal"},
  ...indiaStates.map(([code,name])=>({country:"IN",code:"IN-"+code,name,kind:"State"})),
  ...indiaTerritories.map(([code,name])=>({country:"IN",code:"IN-"+code,name,kind:"Union territory"})),
  {country:"IN",code:"IN-CENTRAL",name:"Central employment jurisdiction",kind:"Federal"},
  ...pk.map(([code,name])=>({country:"PK",code:"PK-"+code,name,kind:code==="IS"?"Capital territory":["GB","JK"].includes(code)?"Territory":"Province"})),
  {country:"PK",code:"PK-FED",name:"Federal employment jurisdiction",kind:"Federal"},
];
