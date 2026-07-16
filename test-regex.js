const str = 'hello deepakHuh test <img alt="deepakHuh" title="deepakHuh"> deepakHuh';
const regex = new RegExp(`(?![^<]*>)\\bdeepakHuh\\b`, 'gi');
console.log(str.replace(regex, 'REPLACED'));
