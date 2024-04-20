import { readFileSync } from "node:fs";

import initGeosJs from "geos-wasm";
import { geojsonToGeosGeom, geosGeomToGeojson } from "geos-wasm/helpers";

import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
import GeoJSONWriter from "jsts/org/locationtech/jts/io/GeoJSONWriter.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import STRtree from "jsts/org/locationtech/jts/index/strtree/STRtree.js";
import RelateOp from "jsts/org/locationtech/jts/operation/relate/RelateOp.js";
import OverlayOp from "jsts/org/locationtech/jts/operation/overlay/OverlayOp.js";

import { geojsonRbush } from "@turf/geojson-rbush";
import { booleanIntersects } from "@turf/boolean-intersects";

import type {
  FeatureCollection,
  Polygon,
  Geometry,
  Feature,
  GeoJsonProperties,
} from "geojson";
import intersect from "@turf/intersect";
import { featureCollection } from "@turf/helpers";
import area from "@turf/area";

type BlockProperties = {
  geoid20: String;
  area: number;
};

type SubmissionProperties = {
  id: Number;
  neighborhood: String;
};

async function geos(
  blockCollection: FeatureCollection<Polygon, BlockProperties>,
  submissionCollection: FeatureCollection<Polygon, SubmissionProperties>
) {
  const geos = await initGeosJs({
    errorHandler: () => {},
  });

  let numIntersections = 0;

  const submissions = new Map(
    submissionCollection.features.map((feature) => [
      geojsonToGeosGeom(feature, geos),
      feature,
    ])
  );

  const blocks = new Map(
    blockCollection.features.map((feature) => {
      const blockNeighborhoodGeomPointer = geojsonToGeosGeom(feature, geos);

      const areaPointer = geos.Module._malloc(8);
      geos.GEOSArea(blockNeighborhoodGeomPointer, areaPointer);
      const area = geos.Module.getValue(areaPointer, "double");
      geos.GEOSFree(areaPointer);

      return [blockNeighborhoodGeomPointer, { feature, area }];
    })
  );

  const tree = geos.GEOSSTRtree_create(10);
  for (const block of blocks.keys()) {
    geos.GEOSSTRtree_insert(tree, block, block);
  }

  const intersections = new Map<
    String,
    Array<[Feature<Geometry, SubmissionProperties>, Number]>
  >();

  function callback(blockPointer: number, submissionPointer: number) {
    const intersects = geos.GEOSIntersects(submissionPointer, blockPointer);

    if (intersects === 0 || intersects === -1) {
      return 1;
    }

    const intersectionPointer = geos.GEOSIntersection(
      submissionPointer,
      blockPointer
    );

    if (intersectionPointer === 0) {
      geos.GEOSFree(intersectionPointer);
      return 1;
    }

    const areaPointer = geos.Module._malloc(8);
    geos.GEOSArea(intersectionPointer, areaPointer);
    const area = geos.Module.getValue(areaPointer, "double");
    geos.GEOSFree(areaPointer);

    const { feature: blockNeighborhood, area: blockNeighborhoodArea } =
      blocks.get(blockPointer)!;

    if (area / blockNeighborhoodArea < 0.01) {
      geos.GEOSFree(intersectionPointer);
      return 1;
    }

    const intersection = geosGeomToGeojson(intersectionPointer, geos);
    intersection.properties = submissions.get(submissionPointer)!.properties;

    geos.GEOSFree(intersectionPointer);

    numIntersections++;

    const blockName = blockNeighborhood.properties.geoid20;
    if (intersections.has(blockName)) {
      intersections.get(blockName)!.push([intersection, 0]);
    } else {
      intersections.set(blockName, [[intersection, 0]]);
    }

    return 1;
  }

  const cbPointer = geos.Module.addFunction(callback, "vii");

  for (const submissionGeomPointer of submissions.keys()) {
    geos.GEOSSTRtree_query(
      tree,
      submissionGeomPointer,
      cbPointer,
      submissionGeomPointer
    );
    geos.GEOSFree(submissionGeomPointer);
  }

  for (const pointer of blocks.keys()) {
    geos.GEOSFree(pointer);
  }

  geos.GEOSSTRtree_destroy(tree);
  geos.Module.removeFunction(cbPointer);

  console.log(numIntersections);
}

function jsts(
  blockCollection: FeatureCollection<Polygon, BlockProperties>,
  submissionCollection: FeatureCollection<Polygon, SubmissionProperties>
) {
  const factory = new GeometryFactory();
  const reader = new GeoJSONReader(factory);
  const writer = new GeoJSONWriter();

  let numIntersections = 0;

  const submissions = new Map(
    submissionCollection.features.map((feature) => [
      reader.read(feature.geometry),
      feature,
    ])
  );

  const blocks = new Map(
    blockCollection.features.map((feature) => {
      const geom = reader.read(feature.geometry);
      const area = geom.getArea();
      return [geom, { feature, area }];
    })
  );

  const tree = new STRtree(10);
  const intersections = new Map<
    String,
    Array<[Feature<Geometry, SubmissionProperties>, Number]>
  >();

  for (const block of blocks.keys()) {
    tree.insert(block.getEnvelopeInternal(), block);
  }

  for (const [submission, submissionFeature] of submissions) {
    const queryBlocks = tree.query(submission.getEnvelopeInternal());
    for (const block of queryBlocks) {
      const intersects = RelateOp.intersects(submission, block);
      if (!intersects) {
        continue;
      }

      const { feature, area: blockArea } = blocks.get(block)!;

      let jstsIntersection: any = undefined;
      try {
        jstsIntersection = OverlayOp.intersection(submission, block);
      } catch {}

      if (jstsIntersection === undefined) {
        continue;
      }

      const area = jstsIntersection.getArea();

      if (area / blockArea < 0.01) {
        continue;
      }

      const intersection: Feature<Geometry, SubmissionProperties> =
        writer.write(jstsIntersection);

      intersection.properties = submissionFeature.properties;

      numIntersections++;

      const blockName = feature.properties.geoid20;
      if (intersections.has(blockName)) {
        intersections.get(blockName)!.push([intersection, 0]);
      } else {
        intersections.set(blockName, [[intersection, 0]]);
      }
    }
  }

  console.log(numIntersections);
}

function turf(
  blockCollection: FeatureCollection<Polygon, BlockProperties>,
  submissionCollection: FeatureCollection<Polygon, SubmissionProperties>
) {
  const tree = geojsonRbush<Polygon, BlockProperties>(10);
  tree.load(blockCollection);

  let numIntersections = 0;

  const intersections = new Map<
    String,
    Array<[Feature<Geometry, SubmissionProperties>, Number]>
  >();

  for (const submission of submissionCollection.features) {
    const queryBlocks = tree.search(submission);
    for (const block of queryBlocks.features) {
      const intersects = booleanIntersects(submission, block);
      if (!intersects) {
        continue;
      }

      const intersection = intersect(
        featureCollection<Polygon, GeoJsonProperties>([submission, block]),
        {
          properties: submission.properties,
        }
      );

      if (intersection === null) {
        continue;
      }

      const blockName = block.properties.geoid20;
      const blockArea = block.properties.area;

      const intersectionArea = area(intersection);

      if (intersectionArea / blockArea < 0.01) {
        continue;
      }

      numIntersections++;

      if (intersections.has(blockName)) {
        intersections.get(blockName)!.push([intersection, 0]);
      } else {
        intersections.set(blockName, [[intersection, 0]]);
      }
    }
  }

  console.log(numIntersections);
}

async function main() {
  const blocks = JSON.parse(
    readFileSync("./data/blocks.json").toString()
  ) as FeatureCollection<Polygon, BlockProperties>;
  const submissions = JSON.parse(
    readFileSync("./data/submissions.json").toString()
  ) as FeatureCollection<Polygon, SubmissionProperties>;

  // console.time("geos");
  // await geos(blocks, submissions);
  // console.timeEnd("geos");

  console.time("turf");
  turf(blocks, submissions);
  console.timeEnd("turf");

  // console.time("jsts");
  // jsts(blocks, submissions);
  // console.timeEnd("jsts");
}

main();
