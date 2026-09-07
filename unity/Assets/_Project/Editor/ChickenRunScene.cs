using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.UI;
using TMPro;
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
            // Dev-only screenshot helper; compiled out of release builds.
            sessionGo.AddComponent<DevCapture>();

            var camRig = camGo.AddComponent<CameraRig>();

            // ── HUD ──────────────────────────────────────────────────────────
            var hud = BuildHud(game, session, input, out var cashOut, out var runEnd);

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
                ("cameraRig", camRig),
                ("hud", hud),
                ("cashOut", cashOut),
                ("runEnd", runEnd));

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
        /// Build the HUD: score pill top-centre, Cash Out egg bottom-right.
        ///
        /// uGUI rather than UI Toolkit. The assignment asks for boring and
        /// maintainable over clever, and uGUI is the mature option for a HUD this
        /// small — two labels and a radial fill.
        /// </summary>
        private static ChickenRunHud BuildHud(
            ChickenRunGame game, ChickenRunSession session, ChickenRunInput input,
            out CashOutButton cashOut, out RunEndOverlay runEndOverlay)
        {
            var canvasGo = new GameObject("HUD",
                typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));

            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;

            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1080f, 1920f);
            // Match height, because the game is portrait and vertical space is
            // what the layout is anchored to. Matching width would shrink the HUD
            // on a tall phone.
            scaler.matchWidthOrHeight = 1f;

            // A hold needs pointer events, which need an EventSystem in the scene.
            // Without one the Cash Out button is simply inert, with no error.
            new GameObject("EventSystem",
                typeof(UnityEngine.EventSystems.EventSystem),
                typeof(UnityEngine.EventSystems.StandaloneInputModule));

            // Everything hangs off a safe-area frame so a notch or a punch-hole
            // camera cannot sit on top of the score.
            var safeGo = new GameObject("SafeArea", typeof(RectTransform), typeof(SafeAreaFrame));
            var safe = safeGo.GetComponent<RectTransform>();
            safe.SetParent(canvasGo.transform, false);
            Stretch(safe);

            // ── Score pill ───────────────────────────────────────────────────
            var pill = NewImage("ScorePill", safe,
                new Color(0.13f, 0.24f, 0.28f), UiSprite());
            pill.type = Image.Type.Sliced;
            var pillRect = pill.rectTransform;
            pillRect.anchorMin = new Vector2(0.5f, 1f);
            pillRect.anchorMax = new Vector2(0.5f, 1f);
            pillRect.pivot = new Vector2(0.5f, 1f);
            pillRect.anchoredPosition = new Vector2(0f, -40f);
            pillRect.sizeDelta = new Vector2(260f, 130f);

            var scoreLabel = NewLabel("Score", pillRect, 84f, FontStyles.Bold);
            Stretch(scoreLabel.rectTransform);

            // ── Blitz readout ────────────────────────────────────────────────
            var blitzGo = new GameObject("BlitzPanel", typeof(RectTransform));
            var blitzRect = blitzGo.GetComponent<RectTransform>();
            blitzRect.SetParent(safe, false);
            blitzRect.anchorMin = new Vector2(0.5f, 1f);
            blitzRect.anchorMax = new Vector2(0.5f, 1f);
            blitzRect.pivot = new Vector2(0.5f, 1f);
            blitzRect.anchoredPosition = new Vector2(0f, -180f);
            blitzRect.sizeDelta = new Vector2(600f, 130f);

            var multiplier = NewLabel("Multiplier", blitzRect, 56f, FontStyles.Bold);
            Anchor(multiplier.rectTransform, new Vector2(0f, 0f), new Vector2(0.34f, 1f));

            var payout = NewLabel("Payout", blitzRect, 56f, FontStyles.Bold);
            payout.color = new Color(0.55f, 0.95f, 0.55f);
            Anchor(payout.rectTransform, new Vector2(0.34f, 0f), new Vector2(0.68f, 1f));

            var nextStep = NewLabel("NextStep", blitzRect, 40f, FontStyles.Normal);
            nextStep.color = new Color(0.85f, 0.85f, 0.85f);
            Anchor(nextStep.rectTransform, new Vector2(0.68f, 0f), new Vector2(1f, 1f));

            blitzGo.SetActive(false);

            // ── Cash Out ─────────────────────────────────────────────────────
            var cashGo = new GameObject("CashOut", typeof(RectTransform));
            var cashRect = cashGo.GetComponent<RectTransform>();
            cashRect.SetParent(safe, false);
            cashRect.anchorMin = new Vector2(1f, 0f);
            cashRect.anchorMax = new Vector2(1f, 0f);
            cashRect.pivot = new Vector2(1f, 0f);
            cashRect.anchoredPosition = new Vector2(-60f, 90f);
            cashRect.sizeDelta = new Vector2(260f, 300f);

            // The ring sits BEHIND the egg so the fill reads as a halo closing
            // around it rather than a bar drawn over the top.
            var ring = NewImage("Ring", cashRect, new Color(0.35f, 0.90f, 0.35f), Knob());
            ring.type = Image.Type.Filled;
            ring.fillMethod = Image.FillMethod.Radial360;
            ring.fillOrigin = (int)Image.Origin360.Top;
            ring.fillClockwise = true;
            ring.fillAmount = 0f;
            Anchor(ring.rectTransform, new Vector2(0.5f, 1f), new Vector2(0.5f, 1f));
            ring.rectTransform.sizeDelta = new Vector2(240f, 240f);
            ring.rectTransform.anchoredPosition = new Vector2(0f, -120f);

            var egg = NewImage("Egg", cashRect, Color.white, Knob());
            Anchor(egg.rectTransform, new Vector2(0.5f, 1f), new Vector2(0.5f, 1f));
            egg.rectTransform.sizeDelta = new Vector2(180f, 180f);
            egg.rectTransform.anchoredPosition = new Vector2(0f, -120f);

            var cashLabel = NewLabel("CashOutLabel", cashRect, 38f, FontStyles.Bold);
            cashLabel.text = "CASH\nOUT";
            cashLabel.alignment = TextAlignmentOptions.Center;
            Anchor(cashLabel.rectTransform, new Vector2(0f, 0f), new Vector2(1f, 0f));
            cashLabel.rectTransform.sizeDelta = new Vector2(0f, 110f);
            cashLabel.rectTransform.anchoredPosition = new Vector2(0f, 10f);

            // The hit target is the whole block, not just the egg: a 180px circle
            // is a small target under a thumb, and missing it in a panic is the
            // worst possible time to be fighting the UI.
            var hit = cashGo.AddComponent<Image>();
            hit.color = new Color(0f, 0f, 0f, 0f);
            hit.raycastTarget = true;

            // ── Run-end overlay ──────────────────────────────────────────────
            // Last child of the canvas so it draws over everything, including the
            // Cash Out control it is meant to block.
            var overGo = new GameObject("RunEnd", typeof(RectTransform), typeof(CanvasGroup));
            var overRect = overGo.GetComponent<RectTransform>();
            overRect.SetParent(canvasGo.transform, false);
            Stretch(overRect);

            var scrim = NewImage("Scrim", overRect, new Color(0f, 0f, 0.05f, 0f), null);
            scrim.raycastTarget = true;
            Stretch(scrim.rectTransform);

            var headline = NewLabel("Headline", overRect, 96f, FontStyles.Bold);
            headline.text = "YOU DIED";
            Anchor(headline.rectTransform, new Vector2(0f, 0.56f), new Vector2(1f, 0.68f));

            var endScore = NewLabel("EndScore", overRect, 190f, FontStyles.Bold);
            Anchor(endScore.rectTransform, new Vector2(0f, 0.40f), new Vector2(1f, 0.56f));

            var detail = NewLabel("Detail", overRect, 44f, FontStyles.Normal);
            detail.color = new Color(0.85f, 0.87f, 0.90f);
            Anchor(detail.rectTransform, new Vector2(0f, 0.33f), new Vector2(1f, 0.40f));

            var hint = NewLabel("Hint", overRect, 36f, FontStyles.Normal);
            hint.color = new Color(0.75f, 0.78f, 0.82f);
            Anchor(hint.rectTransform, new Vector2(0f, 0.16f), new Vector2(1f, 0.23f));

            var runEnd = overGo.AddComponent<RunEndOverlay>();
            Wire(runEnd,
                ("game", game),
                ("group", overGo.GetComponent<CanvasGroup>()),
                ("scrim", scrim),
                ("headline", headline),
                ("detail", detail),
                ("scoreLabel", endScore),
                ("hint", hint));
            runEndOverlay = runEnd;

            cashOut = cashGo.AddComponent<CashOutButton>();
            Wire(cashOut,
                ("session", session), ("game", game), ("input", input),
                ("progressRing", ring), ("egg", egg.rectTransform));

            var hud = canvasGo.AddComponent<ChickenRunHud>();
            Wire(hud,
                ("game", game),
                ("scoreLabel", scoreLabel),
                ("blitzPanel", blitzGo),
                ("multiplierLabel", multiplier),
                ("payoutLabel", payout),
                ("nextStepLabel", nextStep));

            return hud;
        }

        private static Image NewImage(string name, Transform parent, Color color, Sprite sprite)
        {
            var go = new GameObject(name, typeof(RectTransform), typeof(Image));
            go.transform.SetParent(parent, false);
            var img = go.GetComponent<Image>();
            img.color = color;
            img.sprite = sprite;
            img.raycastTarget = false;
            return img;
        }

        private static TMP_Text NewLabel(string name, Transform parent, float size, FontStyles style)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);
            var label = go.AddComponent<TextMeshProUGUI>();
            label.fontSize = size;
            label.fontStyle = style;
            label.alignment = TextAlignmentOptions.Center;
            label.color = Color.white;
            label.raycastTarget = false;
            label.text = "0";
            return label;
        }

        private static void Stretch(RectTransform rect)
        {
            rect.anchorMin = Vector2.zero;
            rect.anchorMax = Vector2.one;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
        }

        private static void Anchor(RectTransform rect, Vector2 min, Vector2 max)
        {
            rect.anchorMin = min;
            rect.anchorMax = max;
            rect.offsetMin = Vector2.zero;
            rect.offsetMax = Vector2.zero;
        }

        /// <summary>
        /// Unity's built-in rounded-rect UI sprite. Using the built-ins avoids
        /// shipping art for a grey-box HUD, and they are included in the build
        /// because the scene references them.
        /// </summary>
        private static Sprite UiSprite() =>
            AssetDatabase.GetBuiltinExtraResource<Sprite>("UI/Skin/UISprite.psd");

        private static Sprite Knob() =>
            AssetDatabase.GetBuiltinExtraResource<Sprite>("UI/Skin/Knob.psd");

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
