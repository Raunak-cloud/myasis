// Country calling codes: ITU national numbering plans, https://www.itu.int/oth/t0202/en
export const callingCodeOptions=[
 ['Australia','61'],['Austria','43'],['Bangladesh','880'],['Belgium','32'],['Brazil','55'],
 ['Canada','1'],['Chile','56'],['China','86'],['Colombia','57'],['Czechia','420'],
 ['Denmark','45'],['Egypt','20'],['Finland','358'],['France','33'],['Germany','49'],
 ['Greece','30'],['Hungary','36'],['India','91'],['Indonesia','62'],['Ireland','353'],
 ['Israel','972'],['Italy','39'],['Japan','81'],['Kenya','254'],['Malaysia','60'],
 ['Mexico','52'],['Nepal','977'],['Netherlands','31'],['New Zealand','64'],['Nigeria','234'],
 ['Norway','47'],['Pakistan','92'],['Peru','51'],['Philippines','63'],['Poland','48'],
 ['Portugal','351'],['Qatar','974'],['Romania','40'],['Saudi Arabia','966'],['Singapore','65'],
 ['South Africa','27'],['South Korea','82'],['Spain','34'],['Sri Lanka','94'],['Sweden','46'],
 ['Switzerland','41'],['Thailand','66'],['United Kingdom','44'],['United States','1'],['Vietnam','84'],
].map(([country,code])=>`${country} (+${code})`);
