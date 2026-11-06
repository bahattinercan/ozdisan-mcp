/**
 * ozdisan.com'un web uygulamasının kullandığı uç noktalardan dönen ham veri tipleri.
 * Yalnızca bu projede kullanılan alanlar tanımlanmıştır; diğer alanlar yok sayılır.
 */

export interface RawMedia {
  path: string;
  field: string; // "Datasheet" | "Picture" | "VideoPath" | "File" | "Thumbnail" | "Logo" | ...
  contentType?: string;
}

export interface RawAvailability {
  mpq?: number;
  minimumOrderQuantity?: number;
  orderQuantityMultiplier?: number;
  totalStock?: number;
  isShowPrice?: boolean;
  isShowStock?: boolean;
  requiresDocument?: boolean;
}

export interface RawManufacturer {
  id?: string;
  name: string;
  slug?: string;
}

export interface RawListPrice {
  breakQuantity: number;
  price: number;
  listingPrice?: number;
  currencyCode?: string;
}

export interface RawListProperty {
  id: string;
  key: string;
  value: string;
  convertedValue?: number;
}

export interface RawListVariant {
  id: string;
  productId?: string;
  mainCategoryId?: string;
  erpRefId: string;
  sku: string;
  fullPath?: string;
  sequenceId?: number;
  description?: string;
  variantPackageType?: string;
  packagingOptions?: string[];
  upcomingStock?: number;
  isDiscounted?: boolean;
  discountRate?: number;
  isRohs?: boolean;
  totalPrice?: number;
  quantity?: number;
  availability?: RawAvailability;
  manufacturer?: RawManufacturer;
  properties?: RawListProperty[];
  tags?: Array<{ id?: string; name?: string } | string>;
  medias?: { pdfPath?: string; imagePath?: string; videoPath?: string; filePath?: string };
  prices?: RawListPrice[];
}

export interface RawFilterValue {
  value: string;
  unitOrder?: string;
  numericValue?: number;
  isDisabled?: boolean;
  unitId?: string;
}

export interface RawMeasurementUnit {
  isBase?: boolean;
  isFormula?: boolean;
  conversionFactor?: string;
  order?: number;
  unit: { id: string; name: string; symbol: string };
}

export interface RawPropertyFilter {
  propertyId: string;
  name: string;
  values?: RawFilterValue[];
  meta?: {
    propertyType?: { id: number; isNumeric: boolean };
    measurement?: { id: string; units: RawMeasurementUnit[] };
    meta?: { order?: number; displayInFilter?: boolean; displayInResult?: boolean };
  };
}

export interface RawCommonFilter {
  name: string;
  code: string;
  order?: number;
  inputType?: string;
  options: Array<{ value: string; label: string }>;
}

export interface RawTableProperty {
  propertyId: string;
  name: string;
  isSortable?: boolean;
}

export interface RawListResponse {
  variantList: {
    pageNumber: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    data: RawListVariant[];
  };
  commonFilters?: RawCommonFilter[];
  propertyFilters?: RawPropertyFilter[];
  tableProperties?: RawTableProperty[];
  categoryTree?: { subCategories?: unknown[]; manufacturers?: Array<{ value: string; label: string }> };
}

export interface RawTopFilterResponse {
  totalCount: number;
  propertyFilters: RawPropertyFilter[];
}

export interface RawCategoryNode {
  id?: string;
  name: string;
  slug: string;
  sequenceId: number;
  level?: number;
  order?: number;
  productCount?: number;
  description?: string;
  subCategories?: RawCategoryNode[];
  medias?: RawMedia[];
}

export interface RawCategorySearchResponse {
  totalCount: number;
  redirectVariantUrl?: string;
  categories: RawCategoryNode[];
  manufacturers?: Array<{ value: string; label: string }>;
}

export interface RawQuickSearchVariant {
  id: string;
  slug: string;
  mainCategoryId?: string;
  sku: string;
  description?: string;
  medias?: RawMedia[];
  category?: {
    id?: string;
    slug?: string;
    slugs?: Array<{ slug: string; langCode?: string; isDefault?: boolean }>;
  };
}

export interface RawQuickSearchResponse {
  variants?: RawQuickSearchVariant[];
  manufacturers?: Array<{ id?: string; name: string; slug?: string }>;
  categories?: Array<{ id?: string; name: string; slug?: string; level?: number }>;
  isSingleMatch?: boolean;
}

export interface RawProductDetail {
  id: string;
  productId?: string;
  erpRefId: string;
  sku: string;
  referenceCode?: string;
  productStatus?: string;
  variantPricingType?: string;
  variantPackageType?: string;
  description?: string;
  detailedDescription?: string;
  upcomingStock?: number;
  currencyCode?: string;
  isDiscounted?: boolean;
  discountRate?: number;
  isRohs?: boolean;
  leadTime?: string;
  fullPathTR?: string;
  fullPathEN?: string;
  availability?: RawAvailability;
  manufacturer?: RawManufacturer & { medias?: RawMedia[] };
  categories?: Array<{ id: string; name: string; sequenceId: number; slug: string; isMain?: boolean }>;
  properties?: Array<{ propertyId: string; name: string; value: string }>;
  medias?: RawMedia[];
  tags?: Array<{ id?: string; name?: string } | string>;
}

export interface RawPriceBreakDetail {
  breakQuantity: number;
  prices: Array<{
    price: number;
    listingPrice?: number;
    totalPrice?: number;
    currency: string;
    extendedPrice?: number;
  }>;
}

export interface RawVariantPriceResponse {
  message?: string;
  success?: boolean;
  data?: {
    variantId: string;
    mpq?: number;
    pricingType?: string;
    packages?: Array<{ packaging: string; priceBreaks: RawPriceBreakDetail[] }>;
    discountRate?: number;
  };
}

export interface RawProductPage {
  data: RawProductDetail;
  breadcrumbData?: Array<{ name: string; slug: string; level: number }>;
  outOfStock?: boolean;
  initialPrice?: { response?: RawVariantPriceResponse; currencyCode?: string };
}

export interface RawRelatedVariant {
  id: string;
  erpRefId: string;
  sku: string;
  fullPath?: string;
  description?: string;
  prices?: RawListPrice[];
  availability?: RawAvailability;
  medias?: RawMedia[];
  manufacturer?: RawManufacturer;
  isRohs?: boolean;
}

export interface RawRelationResponse {
  relations?: Array<{ relatedVariant: RawRelatedVariant; relationType: string }>;
  relationCounts?: Array<{ relationType: string; totalCount: number }>;
}

export interface RawParametricResponse {
  data?: {
    relations?: Array<{ relatedVariant: RawRelatedVariant }>;
    properties?: Array<{ propertyId: string; name?: string; value: string }>;
    totalCount?: number;
  };
}

export interface RawDatasheetResolve {
  url?: string;
  fileName?: string;
  isExternal?: boolean;
}
