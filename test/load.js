// Loads the core sources as a CommonJS module for Node tests.
const fs = require('fs'), path = require('path'), os = require('os');
const src = ['tiff', 'ljpeg', 'dng', 'align', 'engine', 'output'].map((f) => fs.readFileSync(path.join(__dirname, '../src', f + '.js'), 'utf8')).join('\n');
const out = path.join(os.tmpdir(), 'raw-focus-stack-core-test.js');
fs.writeFileSync(out, src + '\nmodule.exports={TiffReader,decodeDNG,readDNGInfo,runStack,makeDemoStack,writeLinearDNG,writeTiff16,renderImage,renderTransform,makeZip,decodeLJ92,alignPair,downscaleLuma,paramsToAffine,affineInfo,TAG,writeTiff,demosaicMHC,median3u8,boxBlur};');
module.exports = require(out);
