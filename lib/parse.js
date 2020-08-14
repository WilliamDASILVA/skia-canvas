"use strict"

//
// Parsers for properties that take CSS-style strings as values
//

// -- Font & Variant --------------------------------------------------------------------
//    https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant
//    https://www.w3.org/TR/css-fonts-3/#font-size-prop

var splitBy = require('string-split-by'),
    {weightMap, sizeMap, featureMap, alternatesMap} = require('./typography'),
    m, cache = {font:{}, variant:{}};

var styleRE = /normal|italic|oblique/,
    smallcapsRE = /normal|small-caps/,
    stretchRE = /normal|(semi-|extra-|ultra-)?(condensed|expanded)/,
    namedSizeRE = /(?:xx?-)?small|smaller|medium|larger|(?:xx?-)?large|normal/,
    numSizeRE = /([\d\.]+)(px|pt|pc|in|cm|mm|%|em|ex|ch|rem|q)/,
    namedWeightRE = /normal|bold(er)?|lighter/,
    numWeightRE = /^(1000|\d{1,3})$/

const unquote = s => s.replace(/^(['"])(.*?)\1$/, "$2"),
      isSize = s => namedSizeRE.test(s) || numSizeRE.test(s),
      isWeight = s => namedWeightRE.test(s) || numWeightRE.test(s);

function parseFont(str){
  if (cache.font[str]===undefined){
    try{
      if (typeof str !== 'string') throw new Error('Font argument must be a string')
      if (!str) throw new Error('Cannot parse an empty string')

      let font = {
        style: 'normal', variant: 'normal', weight: 'normal', stretch: 'normal',
        lineHeight: 'normal', size: '1rem', family: ['serif']
      }

      // make sure size/lineHeight are joined before tokenizing
      let value = str.replace(/\s*\/\*s/, "/"),
          tokens = splitBy(value, /\s+/),
          token;

      while (token = tokens.shift()) {
        let match = styleRE.test(token) ? 'style'
                  : smallcapsRE.test(token) ? 'variant'
                  : stretchRE.test(token) ? 'stretch'
                  : isWeight(token) ? 'weight'
                  : null;

        if (match){
          font[match] = token
        } else if (isSize(token)) {
          let [emSize, leading] = splitBy(token, '/')
          font.size = parseSize(emSize)
          font.lineHeight = parseSize((leading || '1.2').replace(/(\d)$/, '$1em'), font.size)
          font.weight = parseWeight(font.weight)

          // make sure all the numeric fields have legitimate values
          let {style, variant, weight, stretch, lineHeight, size, family} = font,
              invalid = !isFinite(size) ? `font size "${size}"`
                      : !isFinite(lineHeight) ? `line height "${lineHeight}"`
                      : !isFinite(weight) ? `font weight "${weight}"`
                      : false;
          if (invalid) throw new Error(`Invalid ${invalid}`)

          if (tokens.length) {
            font.family = splitBy(tokens.join(' '), /\s*,\s*/).map(unquote)

            // unpack the opentype features for our one possible variant
            font.features = font.variant=='small-caps' ? {on:['smcp', 'onum']} : {};

            // reconstruct the string from the parsed components
            font.canonical = [
              style,
              (variant !== style) && variant,
              ([variant, style].indexOf(weight) == -1) && weight,
              ([variant, style, weight].indexOf(stretch) == -1) && stretch,
              `${size}px/${lineHeight}px`,
              font.family.map(nm => nm.match(/\s/) ? `"${nm}"` : nm).join(", ")
            ].filter(Boolean).join(' ')

            return cache.font[str] = font
          } else throw new Error('Expected at least one font family')
        } else throw new Error(`Unrecognized font attribute ${token}`)
      }
      throw new Error('Font size not provided')
    } catch(e) {
      console.warn(Object.assign(e, {name:"Warning"}))
      cache.font[str] = null
    }
  }
  return cache.font[str]
}

function parseSize(str, emSize=16){
  if (m = numSizeRE.exec(str)){
    let [size, unit] = [parseFloat(m[1]), m[2]]
    return size * (unit == 'px' ? 1
                :  unit == 'pt' ? 1 / 0.75
                :  unit == '%' ? emSize / 100
                :  unit == 'pc' ? 16
                :  unit == 'in' ? 96
                :  unit == 'cm' ? 96.0 / 2.54
                :  unit == 'mm' ? 96.0 / 25.4
                :  unit == 'q' ? 96 / 25.4 / 4
                :  unit.match('r?em') ? emSize
                :  NaN )
  }

  if (m = namedSizeRE.exec(str)){
    return emSize * (sizeMap[m[0]] || 1.0)
  }

  return NaN
}

function parseWeight(str){
  return (m = numWeightRE.exec(str)) ? parseInt(m[0])
       : (m = namedWeightRE.exec(str)) ? weightMap[m[0]]
       : NaN
}

var featuresRE = new RegExp(`(?<= )(${Object.keys(featureMap).join('|')})(?= )`, 'ig'),
    alternatesRE = new RegExp(`(?<= )(${Object.keys(alternatesMap).join('|')})\\(([0-9]+)\\)(?= )`, 'ig'),
    normalRE = / normal |^\s*$/i;

function parseVariant(str){
  if (cache.variant[str]===undefined){
    let raw = ` ${str} `,
        variants = [],
        features = {on:[], off:[]};

    if (normalRE.exec(raw)){
      variants = ['normal'];
    }else{
      for (const match of raw.matchAll(featuresRE)){
        featureMap[match[1]].forEach(feat => {
          if (feat[0] == '-') features.off.push(feat.slice(1))
          else features.on.push(feat)
        })
        variants.push(match[1]);
      }

      for (const match of raw.matchAll(alternatesRE)){
        let subPattern = alternatesMap[match[1]],
            subValue = Math.max(0, Math.min(99, parseInt(match[2], 10))),
            [feat, val] = subPattern.replace(/##/, subValue < 10 ? '0'+subValue : subValue)
                             .replace(/#/, Math.min(9, subValue)).split(' ');
        if (typeof val=='undefined') features.on.push(feat)
        else features[feat] = parseInt(val, 10)
        variants.push(`${match[1]}(${subValue})`)
      }
    }

    cache.variant[str] = {variant:variants.join(' '), features:features};
  }

  return cache.variant[str];
}

// -- Image Filters -----------------------------------------------------------------------
//    https://developer.mozilla.org/en-US/docs/Web/CSS/filter

var m, filterParam = `\\(([^\\)]*(?:\\s*\\))?)\\s*\\)`,
    allFiltersRE = new RegExp(`[a-z\-]+${filterParam}`, 'g'),
    shadowFilterRE = new RegExp(`drop-shadow${filterParam}`),
    plainFilterRE = /(blur|hue-rotate|brightness|contrast|grayscale|invert|opacity|saturate|sepia)\((.*?)\)/,
    percentValueRE = /^(\+|-)?\d{1,3}%$/,
    angleValueRE = /([\d\.]+)(deg|g?rad|turn)/;

function parseFilter(str){
  let filters = {}
  let canonical = []

  for (var spec of str.match(allFiltersRE) || []){
    if (m = shadowFilterRE.exec(spec)){
      let kind = 'drop-shadow',
          args = m[1].trim().split(/\s+/),
          lengths = args.slice(0,3),
          color = args.slice(3).join(' '),
          dims = lengths.map(s => parseSize(s)).filter(isFinite);
      if (dims.length==3 && !!color){
        filters[kind] = [...dims, color]
        canonical.push(`${kind}(${lengths.join(' ')} ${color.replace(/ /g,'')})`)
      }
    }else if (m = plainFilterRE.exec(spec)){
      let [kind, arg] = m.slice(1)
      let val = kind=='blur' ? parseSize(arg)
              : kind=='hue-rotate' ? parseAngle(arg)
              : parsePercentage(arg);
      if (isFinite(val)){
        filters[kind] = val
        canonical.push(`${kind}(${arg.trim()})`)
      }
    }
  }

  return str.trim() == 'none' ? {canonical:'none', filters}
       : canonical.length ? {canonical:canonical.join(' '), filters}
       : null
}

function parsePercentage(str){
  return percentValueRE.test(str.trim()) ? parseInt(str, 10) / 100 : NaN
}

function parseAngle(str){
  if (m = angleValueRE.exec(str.trim())){
    let [amt, unit] = [parseFloat(m[1]), m[2]]
    return unit== 'deg' ? amt
         : unit== 'rad' ? 360 * amt / (2 * Math.PI)
         : unit=='grad' ? 360 * amt / 400
         : unit=='turn' ? 360 * amt
         : NaN
  }
}

module.exports = {parseFont, parseVariant, parseSize, parseFilter}