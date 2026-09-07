using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using SkillApp.Bridge;
using SkillApp.ChickenRun;
using SkillApp.ChickenRun.View;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// Builds the Chicken Run scene in code.
    ///
    /// Authored as a script rather than committed as a .unity asset on purpose. A
    /// scene YAML is thousands of lines of GUIDs and component ids — unreviewable
    /// in a diff, and the first thing to conflict badly. This file says exactly
    /// what the scene contains and why, and regenerates it on demand:
    ///
    ///   Unity.exe -quit -batchmode -nographics -projectPath unity \
    ///     -executeMethod SkillApp.EditorTools.ChickenRunScene.Build
    ///
    /// The trade-off is that the scene cannot be hand-tweaked in the editor and
    /// kept — anything worth keeping has to come back here. For a scene this
    /// small, assembled from a handful of components, that is a good trade.
    /// </summary>
    public static class ChickenRunScene
    {
        public const string ScenePath = "Assets/Scenes/ChickenRun.unity";

        [MenuItem("SkillApp/Build Chicken Run Scene")]
        public static void Build()
        {
            var boardMaterial = EnsureBoardMaterial();

            var scene = EditorSceneManager.NewScene(
                NewSceneSetup.EmptyScene, NewSceneMode.Single);

            // ── Camera ───────────────────────────────────────────────────────
            var camGo = new GameObject("Main Camera");
            camGo.tag = "MainCamera";
            var cam = camGo.AddComponent<Camera>();
            cam.orthographic = true;
            cam.clearFlags = CameraClearFlags.SolidColor;
            // Sky blue: the board reads as outdoors without needing a skybox,
            // which would cost a full-screen draw for no gameplay value.
            cam.backgroundColor = new Color(0.53f, 0.81f, 0.92f);
            // Nothing in this game is far away in world units, so a tight far
            // plane keeps depth precision high on mobile GPUs.
            cam.nearClipPlane = 0.1f;
            cam.farClipPlane = 120f;

            // ── Light ────────────────────────────────────────────────────────
            // One directional light, angled so the low-poly blocks pick up
            // distinguishable shading on their tops and sides. Without it,
            // everything is flat and the rows stop reading as separate.
            var lightGo = new GameObject("Sun");
            var light = lightGo.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.05f;
            light.color = new Color(1f, 0.97f, 0.90f);
            lightGo.transform.rotation = Quaternion.Euler(50f, -35f, 0f);

            // ── Game object graph ────────────────────────────────────────────
            var gameGo = new GameObject("ChickenRun");
            var game = gameGo.AddComponent<ChickenRunGame>();
            var input = gameGo.AddComponent<ChickenRunInput>();
            var world = gameGo.AddComponent<WorldView>();

            // ── Chicken ──────────────────────────────────────────────────────
            var chickenGo = new GameObject("Chicken");
            var bodyGo = GameObject.CreatePrimitive(PrimitiveType.Capsule);
            bodyGo.name = "Body";
            bodyGo.transform.SetParent(chickenGo.transform, false);
            Object.DestroyImmediate(bodyGo.GetComponent<Collider>());
            // The primitive ships with the built-in Default-Material, which URP
            // cannot render — it would draw magenta.
            bodyGo.GetComponent<MeshRenderer>().sharedMaterial = boardMaterial;

            var chickenView = chickenGo.AddComponent<ChickenView>();

            // ── Bridge ───────────────────────────────────────────────────────
            // Present in the scene so a message arriving before anything else is
            // constructed still has somewhere to land.
            var bridgeGo = new GameObject(RNBridge.GameObjectName);
            bridgeGo.AddComponent<RNBridge>();

            // ── Session ──────────────────────────────────────────────────────
            var sessionGo = new GameObject("Session");
            var session = sessionGo.AddComponent<ChickenRunSession>();

            var camRig = camGo.AddComponent<CameraRig>();

            // Wire the serialized references. Done through SerializedObject rather
            // than public fields so the inspector-facing API stays [SerializeField]
            // private, which is what keeps other code from reaching in at runtime.
            Wire(input, ("game", game));
            Wire(world, ("game", game), ("boardMaterial", boardMaterial));
            Wire(chickenView, ("game", game), ("body", bodyGo.transform));
            Wire(camRig, ("game", game), ("camera", cam));
            Wire(session,
                ("game", game),
                ("world", world),
                ("chicken", chickenView),
                ("cameraRig", camRig));

            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath)!);
            EditorSceneManager.SaveScene(scene, ScenePath);

            // Chicken Run is the game the app loads; the spike scene stays in the
            // project but leaves the build.
            EditorBuildSettings.scenes = new[]
            {
                new EditorBuildSettingsScene(ScenePath, true),
            };

            Debug.Log($"[scene] built {ScenePath}");
        }

        /// <summary>
        /// Create the shared board material as a project ASSET.
        ///
        /// It has to be an asset rather than a material built at runtime. A shader
        /// that no material references is stripped from a player build, so
        /// Shader.Find returns null there and every renderer draws magenta — while
        /// working perfectly in the editor, which has everything loaded. This was
        /// a real failure, caught only by running the desktop build.
        /// </summary>
        private static Material EnsureBoardMaterial()
        {
            const string path = "Assets/_Project/ChickenRun/View/Board.mat";

            var existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null) return existing;

            var shader = Shader.Find("Universal Render Pipeline/Unlit");
            if (shader == null)
            {
                Debug.LogWarning("[scene] URP Unlit not found; falling back to Unlit/Color");
                shader = Shader.Find("Unlit/Color");
            }

            var material = new Material(shader) { name = "Board" };
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            AssetDatabase.CreateAsset(material, path);
            AssetDatabase.SaveAssets();
            Debug.Log($"[scene] created {path}");
            return material;
        }

        private static void Wire(Object target, params (string field, Object value)[] pairs)
        {
            var so = new SerializedObject(target);
            foreach (var (field, value) in pairs)
            {
                var prop = so.FindProperty(field);
                if (prop == null)
                {
                    Debug.LogWarning($"[scene] {target.GetType().Name} has no field '{field}'");
                    continue;
                }
                prop.objectReferenceValue = value;
            }
            so.ApplyModifiedPropertiesWithoutUndo();
        }
    }
}
