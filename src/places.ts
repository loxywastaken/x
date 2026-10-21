// Places for the composer's location picker: a built-in list of large cities.
// There is no geocoding service behind it; a post stores the place id and the
// client shows the city's full name.

import { createHash } from "node:crypto";

type City = { name: string; country: string; code: string; lat: number; lng: number };

// name | country | code | lat | lng
const RAW = `Tokyo|Japan|JP|35.68|139.69
Delhi|India|IN|28.61|77.21
Shanghai|China|CN|31.23|121.47
Sao Paulo|Brazil|BR|-23.55|-46.63
Mexico City|Mexico|MX|19.43|-99.13
Cairo|Egypt|EG|30.04|31.24
Mumbai|India|IN|19.08|72.88
Beijing|China|CN|39.9|116.41
Dhaka|Bangladesh|BD|23.81|90.41
Osaka|Japan|JP|34.69|135.5
New York|United States|US|40.71|-74.01
Karachi|Pakistan|PK|24.86|67.01
Buenos Aires|Argentina|AR|-34.6|-58.38
Istanbul|Turkey|TR|41.01|28.98
Kolkata|India|IN|22.57|88.36
Lagos|Nigeria|NG|6.52|3.38
Kinshasa|DR Congo|CD|-4.44|15.27
Manila|Philippines|PH|14.6|120.98
Rio de Janeiro|Brazil|BR|-22.91|-43.17
Tianjin|China|CN|39.34|117.36
Guangzhou|China|CN|23.13|113.26
Los Angeles|United States|US|34.05|-118.24
Moscow|Russia|RU|55.76|37.62
Shenzhen|China|CN|22.54|114.06
Lahore|Pakistan|PK|31.55|74.34
Bangalore|India|IN|12.97|77.59
Paris|France|FR|48.86|2.35
Bogota|Colombia|CO|4.71|-74.07
Jakarta|Indonesia|ID|-6.21|106.85
Chennai|India|IN|13.08|80.27
Lima|Peru|PE|-12.05|-77.04
Bangkok|Thailand|TH|13.76|100.5
Seoul|South Korea|KR|37.57|126.98
Nagoya|Japan|JP|35.18|136.91
Hyderabad|India|IN|17.39|78.49
London|United Kingdom|GB|51.51|-0.13
Tehran|Iran|IR|35.69|51.39
Chicago|United States|US|41.88|-87.63
Chengdu|China|CN|30.57|104.07
Nanjing|China|CN|32.06|118.8
Wuhan|China|CN|30.59|114.31
Ho Chi Minh City|Vietnam|VN|10.82|106.63
Luanda|Angola|AO|-8.84|13.23
Ahmedabad|India|IN|23.02|72.57
Kuala Lumpur|Malaysia|MY|3.14|101.69
Hong Kong|Hong Kong|HK|22.32|114.17
Hangzhou|China|CN|30.27|120.15
Riyadh|Saudi Arabia|SA|24.71|46.68
Baghdad|Iraq|IQ|33.31|44.37
Santiago|Chile|CL|-33.45|-70.67
Surat|India|IN|21.17|72.83
Madrid|Spain|ES|40.42|-3.7
Toronto|Canada|CA|43.65|-79.38
Pune|India|IN|18.52|73.86
Johannesburg|South Africa|ZA|-26.2|28.05
Dar es Salaam|Tanzania|TZ|-6.79|39.21
Barcelona|Spain|ES|41.39|2.17
Singapore|Singapore|SG|1.35|103.82
Saint Petersburg|Russia|RU|59.93|30.34
Yangon|Myanmar|MM|16.87|96.2
Alexandria|Egypt|EG|31.2|29.92
Sydney|Australia|AU|-33.87|151.21
Melbourne|Australia|AU|-37.81|144.96
Berlin|Germany|DE|52.52|13.4
Rome|Italy|IT|41.9|12.5
Kyiv|Ukraine|UA|50.45|30.52
Lisbon|Portugal|PT|38.72|-9.14
Vienna|Austria|AT|48.21|16.37
Warsaw|Poland|PL|52.23|21.01
Prague|Czechia|CZ|50.08|14.44
Budapest|Hungary|HU|47.5|19.04
Bucharest|Romania|RO|44.43|26.1
Athens|Greece|GR|37.98|23.73
Stockholm|Sweden|SE|59.33|18.07
Oslo|Norway|NO|59.91|10.75
Copenhagen|Denmark|DK|55.68|12.57
Helsinki|Finland|FI|60.17|24.94
Dublin|Ireland|IE|53.35|-6.26
Amsterdam|Netherlands|NL|52.37|4.9
Brussels|Belgium|BE|50.85|4.35
Zurich|Switzerland|CH|47.38|8.54
Munich|Germany|DE|48.14|11.58
Hamburg|Germany|DE|53.55|9.99
Milan|Italy|IT|45.46|9.19
Minsk|Belarus|BY|53.9|27.57
Tbilisi|Georgia|GE|41.72|44.79
Yerevan|Armenia|AM|40.18|44.51
Baku|Azerbaijan|AZ|40.41|49.87
Almaty|Kazakhstan|KZ|43.24|76.89
Tashkent|Uzbekistan|UZ|41.3|69.24
Novosibirsk|Russia|RU|55.03|82.92
Vladivostok|Russia|RU|43.12|131.89
Tel Aviv|Israel|IL|32.09|34.78
Dubai|United Arab Emirates|AE|25.2|55.27
Doha|Qatar|QA|25.29|51.53
Nairobi|Kenya|KE|-1.29|36.82
Addis Ababa|Ethiopia|ET|9.03|38.74
Casablanca|Morocco|MA|33.57|-7.59
Accra|Ghana|GH|5.6|-0.19
Cape Town|South Africa|ZA|-33.92|18.42
Taipei|Taiwan|TW|25.03|121.57
Hanoi|Vietnam|VN|21.03|105.85
Kathmandu|Nepal|NP|27.72|85.32
Colombo|Sri Lanka|LK|6.93|79.86
Auckland|New Zealand|NZ|-36.85|174.76
Vancouver|Canada|CA|49.28|-123.12
Montreal|Canada|CA|45.5|-73.57
San Francisco|United States|US|37.77|-122.42
Seattle|United States|US|47.61|-122.33
Boston|United States|US|42.36|-71.06
Washington|United States|US|38.91|-77.04
Miami|United States|US|25.76|-80.19
Houston|United States|US|29.76|-95.37
Dallas|United States|US|32.78|-96.8
Atlanta|United States|US|33.75|-84.39
Denver|United States|US|39.74|-104.99
Phoenix|United States|US|33.45|-112.07
Las Vegas|United States|US|36.17|-115.14
Havana|Cuba|CU|23.11|-82.37
Caracas|Venezuela|VE|10.48|-66.9
Quito|Ecuador|EC|-0.18|-78.47
Montevideo|Uruguay|UY|-34.9|-56.19
La Paz|Bolivia|BO|-16.5|-68.15`;

export const PLACES: (City & { id: string })[] = RAW.split("\n").map((line) => {
	const [name, country, code, lat, lng] = line.split("|");
	const id = createHash("sha1").update(`${name}|${code}`).digest("hex").slice(0, 16);
	return { id, name, country, code, lat: Number(lat), lng: Number(lng) };
});

const BY_ID = new Map(PLACES.map((p) => [p.id, p]));

export function placeObject(p: City & { id: string }) {
	const d = 0.15;
	return {
		id: p.id,
		url: `https://api.twitter.com/1.1/geo/id/${p.id}.json`,
		place_type: "city",
		name: p.name,
		full_name: `${p.name}, ${p.country}`,
		country_code: p.code,
		country: p.country,
		contained_within: [],
		bounding_box: {
			type: "Polygon",
			coordinates: [[[p.lng - d, p.lat - d], [p.lng + d, p.lat - d], [p.lng + d, p.lat + d], [p.lng - d, p.lat + d]]],
		},
		centroid: [p.lng, p.lat],
		attributes: {},
	};
}

export const placeById = (id: string | null | undefined) => {
	const p = id ? BY_ID.get(id) : undefined;
	return p ? placeObject(p) : undefined;
};

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// by name (prefix first, then anywhere), or the nearest to a point
export function searchPlaces(query: string | null, lat: number | null, lng: number | null, limit = 20) {
	const q = fold(query ?? "").trim();
	let found: (City & { id: string })[];
	if (q) {
		const starts = PLACES.filter((p) => fold(p.name).startsWith(q));
		const inside = PLACES.filter((p) => !starts.includes(p) && (fold(p.name).includes(q) || fold(p.country).startsWith(q)));
		found = [...starts, ...inside];
	} else if (lat !== null && lng !== null) {
		const dist = (p: City) => (p.lat - lat) ** 2 + ((p.lng - lng) * Math.cos((lat * Math.PI) / 180)) ** 2;
		found = [...PLACES].sort((a, b) => dist(a) - dist(b));
	} else {
		found = PLACES;
	}
	return found.slice(0, limit).map(placeObject);
}
