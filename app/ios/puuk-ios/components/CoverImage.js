import React, { useState, useEffect } from 'react';
import { Image } from 'react-native';

const DEFAULT_COVER = require('../assets/default_cover.jpg');

export default function CoverImage({ source, style, defaultSource = DEFAULT_COVER, onError, ...props }) {
  const [hasError, setHasError] = useState(false);

  // Extract uri if provided as object { uri: ... } or string
  const uri = typeof source === 'string' ? source : source?.uri;

  // Reset error state when uri changes (e.g. switching tracks)
  useEffect(() => {
    setHasError(false);
  }, [uri]);

  let imageSource = DEFAULT_COVER;
  if (typeof source === 'number') {
    // Local asset require(...)
    imageSource = source;
  } else if (uri && !hasError) {
    imageSource = { uri };
  }

  return (
    <Image
      source={imageSource}
      defaultSource={defaultSource}
      onError={(e) => {
        setHasError(true);
        if (onError) onError(e);
      }}
      style={style}
      {...props}
    />
  );
}

export { DEFAULT_COVER };
