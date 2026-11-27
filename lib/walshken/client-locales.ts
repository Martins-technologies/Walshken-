export const clientLocales = ["en","fr","ur","hi"] as const;
export type ClientLocale = typeof clientLocales[number];
export const clientLocaleNames:Record<ClientLocale,string>={en:"English",fr:"Français",ur:"اردو",hi:"हिन्दी"};
export function isClientLocale(value:unknown):value is ClientLocale{
  return typeof value==="string"&&clientLocales.some(locale=>locale===value);
}

const catalog={
  en:{
    portal:"Client Portal",overview:"Overview",cases:"My cases",documents:"Documents",contact:"Messages & calls",appointments:"Appointments",
    payments:"Payments & invoices",agreements:"Agreements",notifications:"Notifications",profile:"My profile",security:"Security & privacy",support:"Help & feedback",
    welcome:"Welcome, {name}",overviewIntro:"Follow your immigration case and see what needs your attention.",
    casesIntro:"Track each application and review updates from your case team.",documentsIntro:"Submit requested documents and check their status.",
    contactIntro:"Talk with your case team or reach office support.",appointmentsIntro:"Book a consultation and manage upcoming appointments.",
    paymentsIntro:"Review invoices, payments and receipts.",agreementsIntro:"Review and sign agreements from Walshken.",
    notificationsIntro:"See important updates to your cases and account.",profileIntro:"Keep your contact and personal details current.",
    securityIntro:"Manage your password, sessions and privacy requests.",supportIntro:"Ask for help or share feedback privately.",
    site:"Corporate website",signOut:"Sign out",startCase:"Start a case",chooseCase:"Choose a case",openMenu:"Open navigation",closeMenu:"Close navigation",
    skip:"Skip to content",language:"Portal language",loading:"Opening your secure portal…",caseOverview:"Case overview",caseActivity:"Case activity",
    documentRequests:"Document requests",recentNotifications:"Recent notifications",recentUploads:"Recent uploads",billing:"Payments & agreements",
    actions:"Your Next Steps",journey:"Immigration journey",signIn:"Sign in to your portal",email:"Email address",password:"Password",
    submitLogin:"Sign in",register:"Create an account",forgot:"Forgot password?",noUpdates:"You’re up to date",allNotifications:"All notifications",
  },
  fr:{
    portal:"Portail client",overview:"Vue d’ensemble",cases:"Mes dossiers",documents:"Documents",contact:"Messages et appels",appointments:"Rendez-vous",
    payments:"Paiements et factures",agreements:"Ententes",notifications:"Notifications",profile:"Mon profil",security:"Sécurité et confidentialité",support:"Aide et commentaires",
    welcome:"Bienvenue, {name}",overviewIntro:"Suivez votre dossier d’immigration et les démarches à effectuer.",
    casesIntro:"Suivez vos demandes et les nouvelles de votre équipe.",documentsIntro:"Envoyez les documents demandés et consultez leur état.",
    contactIntro:"Communiquez avec votre équipe ou avec le service d’aide.",appointmentsIntro:"Réservez une consultation et gérez vos rendez-vous.",
    paymentsIntro:"Consultez vos factures, paiements et reçus.",agreementsIntro:"Consultez et signez les ententes de Walshken.",
    notificationsIntro:"Consultez les avis importants pour vos dossiers et votre compte.",profileIntro:"Mettez à jour vos coordonnées et renseignements.",
    securityIntro:"Gérez votre mot de passe, vos sessions et vos demandes de confidentialité.",supportIntro:"Demandez de l’aide ou transmettez vos commentaires en privé.",
    site:"Site de l’entreprise",signOut:"Se déconnecter",startCase:"Ouvrir un dossier",chooseCase:"Choisir un dossier",openMenu:"Ouvrir le menu",closeMenu:"Fermer le menu",
    skip:"Aller au contenu",language:"Langue du portail",loading:"Ouverture de votre portail sécurisé…",caseOverview:"Aperçu du dossier",caseActivity:"Activité du dossier",
    documentRequests:"Documents demandés",recentNotifications:"Notifications récentes",recentUploads:"Dépôts récents",billing:"Paiements et ententes",
    actions:"Vos prochaines étapes",journey:"Parcours d’immigration",signIn:"Connexion à votre portail",email:"Adresse courriel",password:"Mot de passe",
    submitLogin:"Se connecter",register:"Créer un compte",forgot:"Mot de passe oublié?",noUpdates:"Vous êtes à jour",allNotifications:"Toutes les notifications",
  },
  ur:{
    portal:"کلائنٹ پورٹل",overview:"جائزہ",cases:"میرے کیس",documents:"دستاویزات",contact:"پیغامات اور کالز",appointments:"ملاقاتیں",
    payments:"ادائیگیاں اور بل",agreements:"معاہدے",notifications:"اطلاعات",profile:"میرا پروفائل",security:"سکیورٹی اور رازداری",support:"مدد اور رائے",
    welcome:"خوش آمدید، {name}",overviewIntro:"اپنے امیگریشن کیس کی پیش رفت اور اگلے اقدامات دیکھیں۔",
    casesIntro:"درخواستوں اور اپنی کیس ٹیم کی تازہ معلومات دیکھیں۔",documentsIntro:"مطلوبہ دستاویزات جمع کریں اور ان کی حیثیت دیکھیں۔",
    contactIntro:"اپنی کیس ٹیم یا دفتری معاونت سے رابطہ کریں۔",appointmentsIntro:"مشاورت بک کریں اور آنے والی ملاقاتیں دیکھیں۔",
    paymentsIntro:"اپنے بل، ادائیگیاں اور رسیدیں دیکھیں۔",agreementsIntro:"والشکن کے معاہدے پڑھیں اور دستخط کریں۔",
    notificationsIntro:"اپنے کیسز اور اکاؤنٹ کی اہم اطلاعات دیکھیں۔",profileIntro:"اپنی ذاتی اور رابطے کی معلومات تازہ رکھیں۔",
    securityIntro:"پاس ورڈ، سیشن اور رازداری کی درخواستیں سنبھالیں۔",supportIntro:"مدد حاصل کریں یا رازداری سے رائے دیں۔",
    site:"کمپنی کی ویب سائٹ",signOut:"سائن آؤٹ",startCase:"کیس شروع کریں",chooseCase:"کیس منتخب کریں",openMenu:"مینو کھولیں",closeMenu:"مینو بند کریں",
    skip:"مواد پر جائیں",language:"پورٹل کی زبان",loading:"محفوظ پورٹل کھولا جا رہا ہے…",caseOverview:"کیس کا جائزہ",caseActivity:"کیس کی سرگرمی",
    documentRequests:"مطلوبہ دستاویزات",recentNotifications:"حالیہ اطلاعات",recentUploads:"حالیہ اپ لوڈز",billing:"ادائیگیاں اور معاہدے",
    actions:"آپ کے اگلے اقدامات",journey:"امیگریشن کے مراحل",signIn:"اپنے پورٹل میں سائن ان کریں",email:"ای میل پتہ",password:"پاس ورڈ",
    submitLogin:"سائن ان",register:"اکاؤنٹ بنائیں",forgot:"پاس ورڈ بھول گئے؟",noUpdates:"کوئی نئی اطلاع نہیں",allNotifications:"تمام اطلاعات",
  },
  hi:{
    portal:"क्लाइंट पोर्टल",overview:"अवलोकन",cases:"मेरे मामले",documents:"दस्तावेज़",contact:"संदेश और कॉल",appointments:"मुलाक़ातें",
    payments:"भुगतान और चालान",agreements:"समझौते",notifications:"सूचनाएँ",profile:"मेरी प्रोफ़ाइल",security:"सुरक्षा और गोपनीयता",support:"सहायता और प्रतिक्रिया",
    welcome:"स्वागत है, {name}",overviewIntro:"अपने आव्रजन मामले की प्रगति और अगले कदम देखें।",
    casesIntro:"आवेदनों और अपनी टीम के अपडेट देखें।",documentsIntro:"माँगे गए दस्तावेज़ जमा करें और उनकी स्थिति देखें।",
    contactIntro:"अपनी टीम या कार्यालय सहायता से बात करें।",appointmentsIntro:"परामर्श बुक करें और आगामी मुलाक़ातें प्रबंधित करें।",
    paymentsIntro:"अपने चालान, भुगतान और रसीदें देखें।",agreementsIntro:"Walshken के समझौते पढ़ें और हस्ताक्षर करें।",
    notificationsIntro:"अपने मामलों और खाते की महत्वपूर्ण सूचनाएँ देखें।",profileIntro:"अपनी संपर्क और व्यक्तिगत जानकारी अद्यतन रखें।",
    securityIntro:"अपना पासवर्ड, सत्र और गोपनीयता अनुरोध प्रबंधित करें।",supportIntro:"सहायता माँगें या निजी तौर पर प्रतिक्रिया दें।",
    site:"कंपनी की वेबसाइट",signOut:"साइन आउट",startCase:"मामला शुरू करें",chooseCase:"मामला चुनें",openMenu:"मेनू खोलें",closeMenu:"मेनू बंद करें",
    skip:"सामग्री पर जाएँ",language:"पोर्टल की भाषा",loading:"आपका सुरक्षित पोर्टल खुल रहा है…",caseOverview:"मामले का अवलोकन",caseActivity:"मामले की गतिविधि",
    documentRequests:"माँगे गए दस्तावेज़",recentNotifications:"हाल की सूचनाएँ",recentUploads:"हाल के अपलोड",billing:"भुगतान और समझौते",
    actions:"आपके अगले कदम",journey:"आव्रजन के चरण",signIn:"अपने पोर्टल में साइन इन करें",email:"ईमेल पता",password:"पासवर्ड",
    submitLogin:"साइन इन",register:"खाता बनाएँ",forgot:"पासवर्ड भूल गए?",noUpdates:"कोई नई सूचना नहीं",allNotifications:"सभी सूचनाएँ",
  }
} as const;
export type ClientText=keyof typeof catalog.en;
export function translateClient(locale:ClientLocale,key:ClientText,values:Record<string,string>={}):string{
  return (catalog[locale][key]??catalog.en[key]).replace(/\{([a-z]+)\}/g,(match,name)=>values[name]??match);
}
