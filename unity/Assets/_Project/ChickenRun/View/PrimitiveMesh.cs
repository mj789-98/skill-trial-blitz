using UnityEngine;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// A unit cube mesh, built in code and shared by everything in the world.
    ///
    /// ── Why not GameObject.CreatePrimitive ───────────────────────────────────
    ///
    /// Because it does not work in the player build, and it fails in a way that
    /// never appears in the editor.
    ///
    /// `CreatePrimitive` attaches a collider, and this game uses no physics at
    /// all — the simulation IS the physics — so Unity's managed stripping removes
    /// the Physics module from the build. On device that produced:
    ///
    ///     Can't add component because class 'BoxCollider' doesn't exist!
    ///     UnityEngine.GameObject:CreatePrimitive(PrimitiveType)
    ///     WorldView:Awake()
    ///
    /// and the world never finished building, so Unity never sent READY and the
    /// app sat on "Loading the course" with a stake already debited. The old code
    /// destroyed the collider immediately after creating it, which is the right
    /// intent and the wrong order: the failure happens inside CreatePrimitive,
    /// before there is anything to destroy.
    ///
    /// Building the mesh directly is better than adding the Physics module back:
    /// it removes an entire engine module from the APK for a game that will never
    /// raycast anything, and it cannot be re-broken by a future stripping-level
    /// change.
    ///
    /// ── Why 24 vertices and not 8 ────────────────────────────────────────────
    ///
    /// A cube has 8 corners but 6 faces with different normals. Sharing corner
    /// vertices between faces means sharing normals, which lights the cube like a
    /// sphere — the faces blur into each other and the blocky look the game is
    /// built around disappears. Four vertices per face, 24 in total, keeps every
    /// face flat.
    /// </summary>
    public static class PrimitiveMesh
    {
        private static Mesh _cube;

        /// <summary>
        /// A 1x1x1 cube centred on the origin. One instance, shared.
        ///
        /// Shared rather than per-object because the world is hundreds of these
        /// and they are all identical; a mesh each would be hundreds of copies of
        /// the same 24 vertices and would break batching.
        /// </summary>
        public static Mesh Cube()
        {
            if (_cube != null) return _cube;

            const float h = 0.5f;

            var vertices = new[]
            {
                // -Z (front)
                new Vector3(-h, -h, -h), new Vector3(-h,  h, -h),
                new Vector3( h,  h, -h), new Vector3( h, -h, -h),
                // +Z (back)
                new Vector3( h, -h,  h), new Vector3( h,  h,  h),
                new Vector3(-h,  h,  h), new Vector3(-h, -h,  h),
                // +Y (top)
                new Vector3(-h,  h, -h), new Vector3(-h,  h,  h),
                new Vector3( h,  h,  h), new Vector3( h,  h, -h),
                // -Y (bottom)
                new Vector3(-h, -h,  h), new Vector3(-h, -h, -h),
                new Vector3( h, -h, -h), new Vector3( h, -h,  h),
                // -X (left)
                new Vector3(-h, -h,  h), new Vector3(-h,  h,  h),
                new Vector3(-h,  h, -h), new Vector3(-h, -h, -h),
                // +X (right)
                new Vector3( h, -h, -h), new Vector3( h,  h, -h),
                new Vector3( h,  h,  h), new Vector3( h, -h,  h),
            };

            var normals = new Vector3[24];
            var uvs = new Vector2[24];
            var faceNormals = new[]
            {
                Vector3.back, Vector3.forward, Vector3.up,
                Vector3.down, Vector3.left, Vector3.right,
            };

            for (int face = 0; face < 6; face++)
            {
                for (int i = 0; i < 4; i++) normals[face * 4 + i] = faceNormals[face];

                uvs[face * 4 + 0] = new Vector2(0f, 0f);
                uvs[face * 4 + 1] = new Vector2(0f, 1f);
                uvs[face * 4 + 2] = new Vector2(1f, 1f);
                uvs[face * 4 + 3] = new Vector2(1f, 0f);
            }

            var triangles = new int[36];
            for (int face = 0; face < 6; face++)
            {
                int v = face * 4;
                int t = face * 6;
                triangles[t + 0] = v;
                triangles[t + 1] = v + 1;
                triangles[t + 2] = v + 2;
                triangles[t + 3] = v;
                triangles[t + 4] = v + 2;
                triangles[t + 5] = v + 3;
            }

            _cube = new Mesh
            {
                name = "SharedCube",
                vertices = vertices,
                normals = normals,
                uv = uvs,
                triangles = triangles,
            };
            _cube.RecalculateBounds();
            // Never unloaded and never edited after this point; marking it means
            // Unity does not keep a CPU-side copy of a mesh nothing will read.
            _cube.UploadMeshData(true);

            return _cube;
        }

        /// <summary>
        /// A renderable cube GameObject: mesh, renderer, no physics.
        ///
        /// The drop-in replacement for GameObject.CreatePrimitive(Cube) that this
        /// game actually needs.
        /// </summary>
        public static GameObject CubeObject(string name, Material material)
        {
            var go = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
            go.GetComponent<MeshFilter>().sharedMesh = Cube();

            var renderer = go.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            // The world is flat-lit and the camera is fixed; per-object shadow
            // casting costs a second pass over every mover for no visible gain.
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            return go;
        }
        private static Mesh _sphere;

        /// <summary>
        /// A unit-diameter UV sphere, for the one thing in either game that must
        /// not be a cube.
        ///
        /// Chicken Run is blocky on purpose and a cube reads as a chicken there.
        /// A basketball does not survive the same treatment: rendered by an
        /// orthographic camera dead-on, a cube is a perfect square, and a square
        /// basketball is the first thing anyone notices.
        ///
        /// Built here for the same reason the cube is — GameObject.CreatePrimitive
        /// attaches a collider, and the Physics module is stripped from player
        /// builds. See Cube() for the crash that causes.
        ///
        /// 16 segments and 12 rings: enough that the silhouette reads as round at
        /// the size a ball is drawn, and few enough to stay a trivial mesh.
        /// </summary>
        public static Mesh Sphere()
        {
            if (_sphere != null) return _sphere;

            const int segments = 16;
            const int rings = 12;
            const float r = 0.5f;

            var vertices = new Vector3[(rings + 1) * (segments + 1)];
            var normals = new Vector3[vertices.Length];
            var uvs = new Vector2[vertices.Length];

            int v = 0;
            for (int y = 0; y <= rings; y++)
            {
                float phi = Mathf.PI * y / rings;         // 0..pi, pole to pole
                float sinPhi = Mathf.Sin(phi);
                float cosPhi = Mathf.Cos(phi);

                for (int x = 0; x <= segments; x++)
                {
                    float theta = 2f * Mathf.PI * x / segments;
                    var n = new Vector3(sinPhi * Mathf.Cos(theta), cosPhi, sinPhi * Mathf.Sin(theta));

                    vertices[v] = n * r;
                    // A sphere centred on the origin has position and normal
                    // pointing the same way, so the normal is the direction.
                    normals[v] = n;
                    uvs[v] = new Vector2((float)x / segments, 1f - (float)y / rings);
                    v++;
                }
            }

            var triangles = new int[rings * segments * 6];
            int t = 0;
            for (int y = 0; y < rings; y++)
            {
                for (int x = 0; x < segments; x++)
                {
                    int a = y * (segments + 1) + x;
                    int b = a + segments + 1;

                    triangles[t++] = a;
                    triangles[t++] = b;
                    triangles[t++] = a + 1;

                    triangles[t++] = a + 1;
                    triangles[t++] = b;
                    triangles[t++] = b + 1;
                }
            }

            _sphere = new Mesh
            {
                name = "SharedSphere",
                vertices = vertices,
                normals = normals,
                uv = uvs,
                triangles = triangles,
            };
            _sphere.RecalculateBounds();
            _sphere.UploadMeshData(true);

            return _sphere;
        }

        /// <summary>A renderable sphere GameObject: mesh, renderer, no physics.</summary>
        public static GameObject SphereObject(string name, Material material)
        {
            var go = new GameObject(name, typeof(MeshFilter), typeof(MeshRenderer));
            go.GetComponent<MeshFilter>().sharedMesh = Sphere();

            var renderer = go.GetComponent<MeshRenderer>();
            renderer.sharedMaterial = material;
            renderer.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            renderer.receiveShadows = false;

            return go;
        }
    }
}
