import Decimal from 'decimal.js';
import {fail} from './server';
export const D=Decimal.clone({precision:40,rounding:Decimal.ROUND_HALF_UP});
export function currencyDigits(currency:string){if(!/^[A-Z]{3}$/.test(currency)||!Intl.supportedValuesOf('currency').includes(currency))return fail(400,'Choose a supported ISO currency code.');// Native payroll calculators and contribution ledgers use hundredths, independent of locale display defaults.
 const digits=['CAD','INR','PKR'].includes(currency)?2:new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits;if(digits===undefined||digits>3)return fail(400,'Unsupported currency precision.');return digits;}
export function minor(value:unknown,digits=2,negative=false){const s=String(value??'').trim();if(!/^-?\d+(?:\.\d+)?$/.test(s))return fail(400,'Enter an exact decimal amount.');const v=new D(s);if(v.decimalPlaces()>digits||!negative&&v.isNegative()||v.abs().gt('20000000'))return fail(400,'Amount exceeds the currency precision or supported range.');const n=v.mul(new D(10).pow(digits)).toNumber();if(!Number.isSafeInteger(n)||Math.abs(n)>2_000_000_000)return fail(400,'Amount exceeds the supported minor-unit range.');return n;}
export const money=(amount:number,digits=2)=>new D(amount).div(new D(10).pow(digits));
export const rounded=(value:Decimal.Value,digits=2)=>new D(value).toDecimalPlaces(digits).toNumber();
export function toMinor(value:Decimal.Value,digits=2){const n=new D(value).mul(new D(10).pow(digits)).toDecimalPlaces(0).toNumber();if(!Number.isSafeInteger(n)||Math.abs(n)>2_000_000_000)return fail(400,'Calculated amount exceeds the supported range.');return n;}
export const prorate=(amount:number,numerator:number,denominator:number)=>new D(amount).mul(numerator).div(denominator).toDecimalPlaces(0).toNumber();
export function payForSeconds(rate:number,seconds:number,multiplier='1'){return new D(rate).mul(seconds).div(3600).mul(multiplier).toDecimalPlaces(0).toNumber();}
export const zeroBalance=()=>({gross:0,taxable:0,pensionable:0,insurable:0,federal:0,provincial:0,cpp:0,cpp2:0,ei:0,qpp:0,qpp2:0,qpip:0,bonus:0,bonusPretax:0,bonusEnhanced:0,bonusCpp:0,bonusEi:0,vacationAccrued:0,vacationUsed:0});
